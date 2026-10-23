import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BackendToClientSchema, ClientToBackendSchema, FALLBACK_SPECS, ReplySchema, TWEAK_CHIPS, type GameSpec } from '@cadabra/spec';

type Out = { text: string; toolUses: { toolUseId: string; name: string; input: unknown }[]; modelId: string };
const script: (() => Out | Promise<Out>)[] = [];
const calls: { messages: unknown[]; tools?: unknown[] }[] = [];
vi.mock('../src/ai/bedrock', () => ({
  converse: vi.fn(async (req: { messages: unknown[] }) => {
    calls.push(structuredClone(req));
    const next = script.shift();
    if (!next) throw new Error('script exhausted');
    return next();
  }),
  screen: vi.fn(async (text: string) => ({ allowed: !/BADWORD/.test(text) })),
  screenOutput: vi.fn(async (text: string) => ({ allowed: !/BADWORD/.test(text) })),
}));

const { tweak, presetTweak, chipsFromText, presetHint } = await import('../src/ai/tweak');
const { requestTweak, runTweakMsg, isTweakEvent } = await import('../src/tweak-room');
const { runPlaytest } = await import('../src/ai/tools');

let n = 0;
const tool = (name: string, input: unknown = {}) => ({ toolUseId: `tu-${++n}`, name, input });
const reply = (...toolUses: ReturnType<typeof tool>[]) => () => ({ text: '', toolUses, modelId: 'm' });
const spec = (id: string) => structuredClone(FALLBACK_SPECS.find((s) => s.id === id)!) as GameSpec;
const params = (s: GameSpec) => s.blocks[0]!.params;

beforeEach(() => { script.length = 0; calls.length = 0; });

describe('presets', () => {
  test.each(FALLBACK_SPECS.map((s) => s.id))('%s: every chip alone changes something and passes playtest at 2 and 4 seats', (id) => {
    const base = spec(id);
    for (const chip of TWEAK_CHIPS) {
      for (const players of [2, 4]) {
        const r = presetTweak(base, [chip], { players });
        expect(r, `${id} ${chip} ${players}`).toBeDefined();
        expect(r!.report.ok).toBe(true);
        expect(r!.changes.length).toBeGreaterThan(0);
        expect(JSON.stringify(r!.spec)).not.toBe(JSON.stringify(base));
      }
    }
  });

  test.each(FALLBACK_SPECS.map((s) => s.id))('%s: all chips at once still give a playable game', (id) => {
    const r = presetTweak(spec(id), [...TWEAK_CHIPS], { players: 2 });
    expect(r).toBeDefined();
    expect(runPlaytest(r!.spec, 2).report.ok).toBe(true);
  });

  test('values stay inside catalog ranges (repeated tweaks clamp)', () => {
    let s = spec('fallback-ring-out');
    for (let i = 0; i < 8; i++) s = presetTweak(s, ['faster', 'bigger-arena'])?.spec ?? s;
    expect(params(s).ringRadius).toBeLessThanOrEqual(400);
    expect(params(s).speed).toBeLessThanOrEqual(600);
  });

  test('chipsFromText maps obvious phrases', () => {
    expect(chipsFromText('low gravity please')).toEqual(['low-gravity']);
    expect(chipsFromText('make it way more chaotic and faster')).toEqual(['faster', 'more-chaos']);
    expect(chipsFromText('giant arena')).toEqual(['bigger-arena']);
    expect(chipsFromText('make it bouncy')).toEqual(['bouncier']);
    expect(chipsFromText('the leader is unfair')).toEqual(['harder-for-leader']);
    expect(chipsFromText('purple hats')).toEqual([]);
  });

  test('presetHint is a valid patch of params', () => {
    const ops = presetHint(spec('fallback-core-rush'), ['faster']);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => o.path.startsWith('/blocks/') || o.path === '/comeback')).toBe(true);
  });
});

describe('tweak (AI)', () => {
  test('one reply: patch_spec + playtest_spec is accepted without a submit turn', async () => {
    const base = spec('fallback-ring-out');
    script.push(reply(
      tool('patch_spec', { patch: [{ op: 'replace', path: '/blocks/0/params/friction', value: 2 }], summary: 'Floaty ring, low friction', changes: ['Friction ↓', 'Floaty ↑'] }),
      tool('playtest_spec'),
    ));
    const steps: string[] = [];
    const r = await tweak(base, [{ chip: 'low-gravity' }], { onProgress: (s) => steps.push(s) });
    expect(calls).toHaveLength(1);
    expect(r.source).toBe('ai');
    expect(r.summary).toBe('Floaty ring, low friction');
    expect(r.changes).toEqual(['Friction ↓', 'Floaty ↑']);
    expect(params(r.spec).friction).toBe(2);
    expect(r.spec.id).not.toBe(base.id);
    expect(r.spec.origin.parentId).toBe(base.id);
    expect(steps).toContain('Bots are playtesting');
    // the brief carries the request, the preset hint and the spec; the prefix is the designer's (cached)
    const brief = JSON.stringify(calls[0]!.messages);
    expect(brief).toContain('Low gravity (chip)');
    expect(brief).toContain('Preset hint');
    expect(brief).toContain('cachePoint');
  });

  test('a failing playtest gets one repair reply', async () => {
    const base = spec('fallback-core-rush');
    script.push(
      reply(tool('patch_spec', { patch: [{ op: 'replace', path: '/blocks/0/params/speed', value: 5000 }], summary: 'x' }), tool('playtest_spec')),
      reply(tool('patch_spec', { patch: [{ op: 'replace', path: '/blocks/0/params/speed', value: 380 }], summary: 'Speed ×1.3', changes: ['Speed ×1.3'] }), tool('playtest_spec')),
    );
    const r = await tweak(base, [{ text: 'faster' }], {});
    expect(calls).toHaveLength(2);
    expect(r.source).toBe('ai');
    expect(params(r.spec).speed).toBe(380);
  });

  test('AI failure falls back to presets (typed text mapped to chips)', async () => {
    script.push(() => { throw new Error('boom'); });
    const r = await tweak(spec('fallback-neon-dash'), [{ text: 'way faster!!' }], {});
    expect(r.source).toBe('preset');
    expect(r.changes).toContain('Speed ×1.3');
    expect(r.spec.origin.parentId).toBe('fallback-neon-dash');
  });

  test('an AI reply that never patches falls back to presets', async () => {
    script.push(reply(tool('playtest_spec')), reply(tool('submit_spec')), reply(tool('submit_spec')));
    const r = await tweak(spec('fallback-ring-out'), [{ chip: 'bouncier' }], {});
    expect(r.source).toBe('preset');
  });

  test('blocked text is dropped; nothing left -> same game, source none', async () => {
    const base = spec('fallback-ring-out');
    const r = await tweak(base, [{ text: 'BADWORD stuff' }], {});
    expect(r).toMatchObject({ source: 'none', blocked: true });
    expect(r.spec).toEqual(base);
    expect(calls).toHaveLength(0);
  });

  test('blocked summary is replaced by a generic line', async () => {
    script.push(reply(
      tool('patch_spec', { patch: [{ op: 'replace', path: '/blocks/0/params/friction', value: 3 }], summary: 'BADWORD', changes: ['ok'] }),
      tool('playtest_spec'),
    ));
    const r = await tweak(spec('fallback-ring-out'), [{ chip: 'low-gravity' }], {});
    expect(r.summary).toBe('Rules remixed');
  });

  test('invalid input spec throws (runTweakMsg turns that into no reply)', async () => {
    await expect(tweak({ nope: 1 }, [{ chip: 'faster' }], {})).rejects.toThrow();
    const m = { t: 'forge.tweak' as const, code: 'BCDF', id: 't1', spec: { nope: 1 }, requests: [{ chip: 'faster' as const }] };
    expect(await runTweakMsg(m, { ai: false })).toBeUndefined();
  });
});

describe('protocol + room', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const sent: unknown[] = [];
  const ctx = { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: 'T', now: () => 1, send: async (_c: string, m: unknown) => { sent.push(m); return true; } } as never;
  const msg = { t: 'forge.tweak' as const, code: 'BCDF', id: 't1', spec: spec('fallback-ring-out'), requests: [{ chip: 'faster' as const }, { text: 'more bounce' }], seats: 1 };
  beforeEach(() => { ddbMock.reset(); sent.length = 0; });

  test('forge.tweak / forge.tweaked / tweak.ask parse', async () => {
    expect(ClientToBackendSchema.safeParse(msg).success).toBe(true);
    expect(ClientToBackendSchema.safeParse({ ...msg, requests: [] }).success).toBe(false);
    expect(ClientToBackendSchema.safeParse({ ...msg, requests: [{ chip: 'nope' }] }).success).toBe(false);
    expect(ReplySchema.safeParse({ reply: 'tweak.ask', chip: 'low-gravity' }).success).toBe(true);
    expect(ReplySchema.safeParse({ reply: 'tweak.ask', text: 'moon gravity' }).success).toBe(true);
    const out = await runTweakMsg(msg, { ai: false });
    expect(BackendToClientSchema.safeParse(out).success).toBe(true);
    expect(out).toMatchObject({ t: 'forge.tweaked', id: 't1', source: 'preset' });
  });

  test('non-TV is rejected', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { role: 'player', room: 'BCDF' } });
    const invoke = vi.fn();
    await requestTweak(ctx, 'c1', msg, { invoke, endpoint: 'e' });
    expect(invoke).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ t: 'error', code: 'room.badRequest' });
  });

  test('TV request invokes the forge lambda with a tweak event', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { role: 'tv', room: 'BCDF' } });
    ddbMock.on(UpdateCommand).resolves({});
    const invoke = vi.fn(async () => {});
    await requestTweak(ctx, 'c1', msg, { invoke, endpoint: 'e', nowMs: 5 });
    expect(invoke).toHaveBeenCalledOnce();
    const ev = (invoke.mock.calls[0] as unknown[])[0];
    expect(isTweakEvent(ev)).toBe(true);
    expect(ev).toMatchObject({ kind: 'tweak', conn: 'c1', receivedAt: 5 });
  });

  test('invoke failure -> presets answered locally', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { role: 'tv', room: 'BCDF' } });
    ddbMock.on(UpdateCommand).resolves({});
    await requestTweak(ctx, 'c1', msg, { invoke: async () => { throw new Error('no fn'); }, endpoint: 'e' });
    expect(sent[0]).toMatchObject({ t: 'forge.tweaked', source: 'preset' });
  });

  test('over the room budget -> presets only, no invoke', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { role: 'tv', room: 'BCDF' } });
    ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    const invoke = vi.fn();
    await requestTweak(ctx, 'c1', msg, { invoke, endpoint: 'e' });
    expect(invoke).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ t: 'forge.tweaked', source: 'preset' });
  });
});
