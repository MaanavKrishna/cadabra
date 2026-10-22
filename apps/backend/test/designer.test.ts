import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PitchSchema, type GameSpec, type Pitch } from '@cadabra/spec';
import heistJson from '../../../packages/spec/test/fixtures/heist.json';

type Out = { text: string; toolUses: { toolUseId: string; name: string; input: unknown }[]; stopReason?: string; modelId: string };
type Req = { model: string; system: string; messages: { role: string; content: Record<string, unknown>[] }[]; tools?: unknown[]; timeoutMs: number };

const script: ((req: Req) => Out | Promise<Out>)[] = [];
const calls: Req[] = [];
vi.mock('../src/ai/bedrock', () => ({
  converse: vi.fn(async (req: Req) => {
    calls.push(structuredClone(req));
    const next = script.shift();
    if (!next) throw new Error('script exhausted');
    return next(req);
  }),
  screen: vi.fn(async () => ({ allowed: true })),
}));

const { design, pitch, remix, DesignTimeout } = await import('../src/ai/designer');
const { extractJson, CATALOG, runTool } = await import('../src/ai/tools');
const { designerSystemPrompt, EXAMPLE_SPECS } = await import('../src/ai/prompts');
const { runPlaytest } = await import('../src/ai/tools');

const heist = heistJson as unknown as GameSpec;
const { version: _v, id: _i, origin: _o, ...heistBody } = heist;
const noTiptoe = { ...heistBody, controller: heist.controller.filter((w) => w.id !== 'tiptoe') };

let n = 0;
const tool = (name: string, input: unknown = {}) => ({ toolUseId: `tu-${++n}`, name, input });
const reply = (...toolUses: ReturnType<typeof tool>[]) => () => ({ text: '', toolUses, modelId: 'm' });
const textReply = (text: string) => () => ({ text, toolUses: [], modelId: 'm' });

const P: Pitch = {
  id: 'p1', title: 'Ladoo Heist', hook: 'Sneak ladoos past a bear.', keyArtPrompt: 'bear, ladoos, no text',
  palette: heist.theme.palette, blocksSketch: ['sneak', 'collect'],
};
const ctx = (over: Partial<Parameters<typeof design>[1]> = {}) => {
  const steps: string[] = [];
  return {
    steps,
    c: {
      ingredients: ['ladoo', 'sleeping bear'], players: ['Asha', 'Ravi'], householdBlocks: [],
      deadlineMs: 20000, onProgress: (s: string) => steps.push(s), ...over,
    },
  };
};
/** Tool results the designer sent back, in order. */
const toolResults = () => calls.flatMap((r) => r.messages.at(-1)!.content)
  .filter((b) => b.toolResult).map((b) => b.toolResult as { status: string; content: { text: string }[] });

beforeEach(() => {
  script.length = 0;
  calls.length = 0;
});

describe('designer', () => {
  test('design submits after validate+playtest pass', async () => {
    script.push(
      reply(tool('validate_spec', { spec: heistBody }), tool('playtest_spec')),
      reply(tool('submit_spec')),
    );
    const { c, steps } = ctx();
    const r = await design(P, c);
    expect(r.report.ok).toBe(true);
    expect(r.toolCalls).toBe(3);
    expect(r.spec.title).toBe('Ladoo Heist');
    expect(r.spec.origin).toEqual({ ingredients: ['ladoo', 'sleeping bear'], wild: false });
    expect(r.spec.id).toMatch(/^ladoo-heist-/);
    expect(steps).toContain('Bots are playtesting');
    expect(steps.length).toBeGreaterThan(2);
    // the brief carries the players' names; the system prompt is the designer prompt; tools offered
    expect(JSON.stringify(calls[0]!.messages[0])).toContain('Asha');
    expect(calls[0]!.system).toBe(designerSystemPrompt());
    expect(JSON.stringify(calls[0]!.tools)).toContain('submit_spec');
    expect(JSON.stringify(calls[0]!.tools)).not.toContain('request_wild_block');
  });

  test('design repairs after playtest failure using patch_spec', async () => {
    let seen = '';
    script.push(
      reply(tool('playtest_spec', { spec: noTiptoe })),
      (req) => {
        seen = JSON.stringify(req.messages.at(-1));
        return reply(
          tool('patch_spec', { patch: [{ op: 'add', path: '/controller/-', value: { kind: 'hold', id: 'tiptoe', label: 'Tiptoe' } }] }),
          tool('playtest_spec'),
        )();
      },
      reply(tool('submit_spec')),
    );
    const { c, steps } = ctx();
    const r = await design(P, c);
    expect(seen).toContain('missing controller widget for sneak');
    expect(r.report.ok).toBe(true);
    expect(r.spec.controller.some((w) => w.id === 'tiptoe')).toBe(true);
    expect(r.toolCalls).toBe(4);
    expect(steps).toContain('Wiring the controllers');
  });

  test('submit_spec rejected when playtest fails', async () => {
    script.push(
      reply(tool('submit_spec', { spec: noTiptoe })),
      reply(tool('submit_spec', { spec: heistBody })),
    );
    const r = await design(P, ctx().c);
    const first = toolResults()[0]!;
    expect(first.status).toBe('error');
    expect(first.content[0]!.text).toContain('"accepted":false');
    expect(first.content[0]!.text).toContain('missing controller widget');
    expect(r.report.ok).toBe(true);
    expect(r.spec.controller.some((w) => w.id === 'tiptoe')).toBe(true);
    // direct: the tool itself refuses a spec that fails playtest
    const state = { normalize: (s: unknown) => ({ ...(s as object), version: 1, id: 'x', origin: { ingredients: [], wild: false } }) };
    expect(runTool('submit_spec', { spec: noTiptoe }, state).submitted).toBeUndefined();
  });

  test('DesignTimeout after deadline', async () => {
    script.push(() => new Promise<Out>(() => {})); // the model never answers
    const t0 = Date.now();
    await expect(design(P, ctx({ deadlineMs: 150 }).c)).rejects.toBeInstanceOf(DesignTimeout);
    expect(Date.now() - t0).toBeLessThan(1000);
    // turn budget: 8 replies that never submit -> DesignTimeout, never a 9th call
    for (let i = 0; i < 12; i++) script.push(reply(tool('list_blocks')));
    calls.length = 0;
    await expect(design(P, ctx().c)).rejects.toBeInstanceOf(DesignTimeout);
    expect(calls).toHaveLength(8);
  });

  test('pitch returns exactly 3 with valid palettes', async () => {
    const good = (t: string) => ({ title: t, hook: 'h', keyArtPrompt: 'k, no text', palette: heist.theme.palette, blocksSketch: ['collect', 'made-up'] });
    script.push(textReply(`Sure! Here are your pitches:\n\`\`\`json\n${JSON.stringify([good('A'), { ...good('B'), palette: { bg: 'red' } }, good('C'), good('D')])}\n\`\`\``));
    const ps = await pitch(['penguins', 'lava floor'], ['Mia'], { familySafe: true, deadlineMs: 8000 });
    expect(ps).toHaveLength(3);
    for (const p of ps) expect(PitchSchema.safeParse(p).success).toBe(true);
    expect(ps.map((p) => p.title)).toEqual(['A', 'B', 'C']);
    expect(ps[0]!.blocksSketch).toEqual(['collect']);
    expect(calls[0]!.model).toBe('fast');
    // a broken reply still yields 3 valid pitches (fallbacks)
    script.push(textReply('[{"title": "Only one", "hook": "x", "keyArtPrompt": "y"}]'));
    const ps2 = await pitch(['penguins'], [], { familySafe: false, deadlineMs: 8000 });
    expect(ps2).toHaveLength(3);
    for (const p of ps2) expect(PitchSchema.safeParse(p).success).toBe(true);
    expect(new Set(ps2.map((p) => p.id)).size).toBe(3);
  });

  test('remix produces patched spec whose parentId is original id', async () => {
    script.push(textReply('```json\n{"patch":[{"op":"replace","path":"/durationSec","value":100},{"op":"replace","path":"/timeline/1/atSec","value":90}],"wildNeeded":false,"summary":"longer"}\n```'));
    const steps: string[] = [];
    const r = await remix(heist, 'make it longer', { deadlineMs: 10000, onProgress: (s) => steps.push(s) });
    expect(r.wildNeeded).toBe(false);
    expect(r.spec.durationSec).toBe(100);
    expect(r.spec.origin.parentId).toBe(heist.id);
    expect(r.spec.id).not.toBe(heist.id);
    expect(r.spec.origin.ingredients).toEqual(heist.origin.ingredients);
    expect(steps).toContain('Bots are playtesting');
  });

  test('extractJson finds the first JSON value in prose and code fences', () => {
    expect(extractJson('Here you go:\n```json\n{"a": {"b": "}"}}\n```\nthanks')).toEqual({ a: { b: '}' } });
    expect(extractJson('Sure! {"x": [1, 2, {"y": "a\\"b{"}]} and {"z": 1}')).toEqual({ x: [1, 2, { y: 'a"b{' }] });
    expect(extractJson('```\n[1,2]\n```')).toEqual([1, 2]);
    expect(extractJson('{broken {"ok": true}')).toEqual({ ok: true });
    expect(extractJson('no json here')).toBeUndefined();
  });

  test('system prompt contains every catalog block id and the design rules', () => {
    const sys = designerSystemPrompt();
    expect(CATALOG.length).toBe(8);
    for (const k of CATALOG) expect(sys).toContain(`### ${k.id} `);
    for (const k of CATALOG) for (const param of Object.keys((k.params as { properties: object }).properties)) expect(sys).toContain(param);
    expect(sys).toMatch(/players' real names/);
    expect(sys).toMatch(/Only the blocks and params in the catalog/);
    expect(sys).toMatch(/durationSec − 10/);
    expect(sys).toMatch(/English only/);
    expect(sys).toMatch(/Family-safe/);
  });

  test('every example spec in the prompt passes validate + playtest', () => {
    for (const ex of EXAMPLE_SPECS) {
      const spec = { ...ex, version: 1, id: 'ex', origin: { ingredients: [], wild: false } };
      const { report } = runPlaytest(spec);
      expect(report.reasons, ex.title).toEqual([]);
    }
  });
});
