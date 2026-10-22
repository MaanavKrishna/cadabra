import type { ContentBlock, Message, ToolResultBlock } from '@aws-sdk/client-bedrock-runtime';
import jsonpatch, { type Operation } from 'fast-json-patch';
import { z } from 'zod';
import type { PlaytestReport } from '@cadabra/engine';
import { PaletteSchema, PitchSchema, type GameSpec, type Pitch } from '@cadabra/spec';
import { converse, screen, screenOutput, type ConverseOutput, type ConverseRequest, type ToolSpec } from './bedrock';
import {
  DESIGN_KICKOFF, REMIX_KICKOFF, designBrief, designerSystemPrompt, pitchSystemPrompt, pitchUserPrompt, remixPrompt,
  remixSystemPrompt,
} from './prompts';
import { CATALOG, TOOL_SPECS, extractJson, runPlaytest, runTool, type ToolState } from './tools';

export class DesignTimeout extends Error {
  override name = 'DesignTimeout';
}
export class RemixFailed extends Error {
  override name = 'RemixFailed';
}

export const MAX_TURNS = 8;
const DESIGN_MAX_TOKENS = 4096;
/** Prompt caching on Bedrock (cachePoint blocks). Set CADABRA_PROMPT_CACHE=0 to disable. */
let cacheEnabled = process.env.CADABRA_PROMPT_CACHE !== '0';
const CACHE_POINT = { cachePoint: { type: 'default' } } as unknown as ContentBlock;
const log = (...a: unknown[]) => console.warn('[designer]', ...a);
/** Test hook: re-enable prompt caching after a test disabled it. */
export function _resetPromptCache(): void { cacheEnabled = process.env.CADABRA_PROMPT_CACHE !== '0'; }

/**
 * `deadlineMs` is a budget in ms from now (e.g. 25000). An absolute epoch-ms timestamp
 * (anything after the year 2001) is accepted too.
 */
const toDeadline = (deadlineMs: number) => (deadlineMs > 1e12 ? deadlineMs : Date.now() + deadlineMs);

/** converse() raced against the deadline, so a hung call can't overrun it. */
async function call(req: Omit<ConverseRequest, 'timeoutMs'>, deadline: number, what: string): Promise<ConverseOutput> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DesignTimeout(`${what}: deadline passed`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DesignTimeout(`${what}: deadline passed`)), remaining);
  });
  const attempt = (r: ConverseRequest) => converse(r);
  // Once caching is off, every later call must go out without cachePoints too.
  const first = cacheEnabled ? req : stripCache(req);
  try {
    return await Promise.race([
      attempt({ ...first, timeoutMs: remaining }).catch((e: unknown) => {
        // A model that rejects cachePoint blocks: drop caching and retry once without it.
        if (cacheEnabled && /cach/i.test(String((e as Error)?.message)) && (e as Error)?.name === 'ValidationException') {
          log('prompt caching rejected; disabling');
          cacheEnabled = false;
          return attempt({ ...stripCache(req), timeoutMs: Math.max(1, deadline - Date.now()) });
        }
        if (Date.now() >= deadline) throw new DesignTimeout(`${what}: deadline passed`);
        throw e;
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function stripCache<T extends Omit<ConverseRequest, 'timeoutMs'>>(req: T): T {
  const isCache = (b: object) => 'cachePoint' in b;
  return {
    ...req,
    tools: req.tools?.filter((t) => !isCache(t)),
    messages: req.messages.map((m) => ({ ...m, content: m.content?.filter((c) => !isCache(c)) })),
  };
}

const withCache = <T>(blocks: T[], cache: T): T[] => (cacheEnabled ? [...blocks, cache] : blocks);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';
const rand = () => Math.random().toString(36).slice(2, 7);
export const newSpecId = (title: string) => `${slug(title)}-${rand()}`;

function stamp(spec: unknown, fields: { id: string; origin: GameSpec['origin'] }): unknown {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const s = { ...(spec as Record<string, unknown>) };
  s.version = 1;
  s.id = fields.id;
  s.origin = fields.origin;
  if (s.modifiers === undefined) s.modifiers = [];
  return s;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Progress label for the Forge animation, from the tool being run. */
function progressLabel(name: string, input: unknown, state: ToolState): string {
  switch (name) {
    case 'list_blocks':
    case 'get_block_schema':
      return 'Picking blocks';
    case 'validate_spec':
      return 'Checking the rules';
    case 'playtest_spec':
      return 'Bots are playtesting';
    case 'submit_spec':
      return 'Final bot playtest';
    case 'patch_spec': {
      const spec = isObj(state.current) ? state.current : undefined;
      const blocks = Array.isArray(spec?.blocks) ? (spec.blocks as { params?: Record<string, unknown> }[]) : [];
      const sprites = blocks.flatMap((b) => [b.params?.guardSprite, b.params?.hazardSprite, b.params?.itemSprite])
        .filter((x): x is string => typeof x === 'string');
      const ops = isObj(input) && Array.isArray(input.patch) ? (input.patch as { path?: string }[]) : [];
      const paths = ops.map((o) => String(o.path ?? '')).join(' ');
      if (/controller/.test(paths)) return 'Wiring the controllers';
      if (/timeline/.test(paths)) return 'Plotting the surprise';
      return sprites[0] ? `Tuning the ${sprites[0].replace(/[-_]/g, ' ')}` : 'Tuning the rules';
    }
    default:
      return 'Designing';
  }
}

/** Build the agent's game from the voted pitch: tool-calling loop over the engine. */
export async function design(p: Pitch, ctx: {
  ingredients: string[]; players: string[]; householdBlocks: string[]; deadlineMs: number; onProgress: (step: string) => void;
  /** Guardrails on the player-visible text before returning (default true). */
  familySafe?: boolean;
}): Promise<{ spec: GameSpec; report: PlaytestReport; toolCalls: number }> {
  const deadline = toDeadline(ctx.deadlineMs);
  const progress = (s: string) => {
    try { ctx.onProgress(s); } catch { /* progress is cosmetic */ }
  };
  const known = new Set(CATALOG.map((k) => k.id));
  const id = newSpecId(p.title);
  const origin = { ingredients: ctx.ingredients.slice(0, 8), wild: false };
  // Playtest with the room's real head count (bots fill seats, min 2, max 4).
  const state: ToolState = { normalize: (s) => stamp(s, { id, origin }), players: Math.min(4, Math.max(2, ctx.players.length)) };
  const familySafe = ctx.familySafe ?? true;
  const system = designerSystemPrompt();
  const brief = designBrief(p, {
    ingredients: ctx.ingredients,
    players: ctx.players,
    householdBlocks: ctx.householdBlocks.filter((b) => known.has(b)),
    secondsLeft: Math.max(1, Math.round((deadline - Date.now()) / 1000)),
  });
  const messages: Message[] = [
    { role: 'user', content: [...withCache([{ text: DESIGN_KICKOFF } as ContentBlock], CACHE_POINT), { text: brief }] },
  ];
  const tools = withCache(TOOL_SPECS, CACHE_POINT as unknown as ToolSpec);
  let toolCalls = 0;

  progress('Reading the ingredients');
  const finish = async (r: { spec: GameSpec; report: PlaytestReport }) => {
    progress('Game ready');
    return { spec: await screenSpec(r.spec, familySafe, deadline), report: r.report, toolCalls };
  };
  const overdue = () => {
    if (Date.now() >= deadline) throw new DesignTimeout('design: deadline passed during tool execution');
  };

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const left = deadline - Date.now();
      const last = messages[messages.length - 1]!;
      if (turn > 0 && (turn >= MAX_TURNS - 2 || left < 8000)) {
        last.content = [...(last.content ?? []), {
          text: state.passing
            ? 'Time is almost up: call submit_spec with no arguments now.'
            : `Time is almost up (${Math.round(left / 1000)} s, ${MAX_TURNS - turn} replies left): fix the reasons and submit_spec in this reply.`,
        }];
      }
      if (turn === 0) progress('Picking blocks');
      const out = await call({ model: 'designer', system, messages, tools, maxTokens: DESIGN_MAX_TOKENS }, deadline, 'design');
      if (out.stopReason === 'max_tokens') {
        // Truncated reply: a half-written spec/tool call is useless. Ask for small patches instead.
        messages.push({ role: 'assistant', content: [{ text: out.text.trim() ? out.text : '(cut off)' }] });
        messages.push({ role: 'user', content: [{ text: 'Your reply was cut off (too long). Use patch_spec with small changes (or omit default params), then playtest_spec.' }] });
        continue;
      }
      const content: ContentBlock[] = [];
      if (out.text.trim()) content.push({ text: out.text });
      for (const tu of out.toolUses) content.push({ toolUse: tu });
      if (!content.length) content.push({ text: '(no reply)' });
      messages.push({ role: 'assistant', content });

      if (!out.toolUses.length) {
        // The model answered in prose/JSON instead of calling a tool: treat a spec in the text as a submission.
        const found = extractJson(out.text);
        if (isObj(found)) {
          progress('Bots are playtesting');
          const r = runTool('submit_spec', { spec: found }, state);
          toolCalls++;
          if (r.submitted) return await finish(r.submitted);
          overdue();
          messages.push({ role: 'user', content: [{ text: `Not accepted: ${JSON.stringify(r.result)}. Use the tools: patch_spec, then playtest_spec, then submit_spec.` }] });
        } else {
          messages.push({ role: 'user', content: [{ text: 'Use the tools: write the spec and call playtest_spec, then submit_spec.' }] });
        }
        continue;
      }

      const results: ContentBlock[] = [];
      for (const tu of out.toolUses) {
        const name = tu.name ?? '';
        progress(progressLabel(name, tu.input, state));
        const r = runTool(name, tu.input, state);
        toolCalls++;
        if (r.submitted) return await finish(r.submitted);
        const block: ToolResultBlock = {
          toolUseId: tu.toolUseId!,
          content: [{ text: JSON.stringify(r.result) }],
          status: r.status,
        };
        results.push({ toolResult: block });
      }
      messages.push({ role: 'user', content: results });
      overdue();
    }
  } catch (e) {
    // Any failure (deadline, throttling, outage): a spec that already passed playtest is good enough.
    if (state.passing) {
      log(`${(e as Error)?.name ?? 'error'}; returning last spec that passed playtest`);
      return finish(state.passing);
    }
    throw e;
  }
  if (state.passing) return finish(state.passing);
  throw new DesignTimeout(`design: no playtested spec after ${MAX_TURNS} turns`);
}

// ---------------------------------------------------------------- screening

const SAFE = {
  title: 'Mystery Game',
  hook: 'A brand new party game. Get ready!',
  intro: 'Get ready!',
  finale: 'What a game! Let us see who won.',
  tutorial: 'Use the controls on your phone. Have fun!',
  hostLine: 'Something just changed!',
} as const;

/**
 * Guardrails on everything players see or hear: one batched call; only if that is blocked,
 * each field is screened alone and blocked ones become safe generic lines. Fails closed.
 */
export async function screenSpec(spec: GameSpec, familySafe: boolean, deadline: number): Promise<GameSpec> {
  const fields: { text: string; set: (s: GameSpec) => void }[] = [
    { text: spec.title, set: (s) => { s.title = SAFE.title; } },
    { text: spec.hook, set: (s) => { s.hook = SAFE.hook; } },
    { text: spec.host.intro, set: (s) => { s.host.intro = SAFE.intro; } },
    { text: spec.host.finale, set: (s) => { s.host.finale = SAFE.finale; } },
    { text: spec.host.tutorial, set: (s) => { s.host.tutorial = SAFE.tutorial; } },
    ...spec.timeline.map((ev, i) => ({ text: ev.hostLine, set: (s: GameSpec) => { s.timeline[i]!.hostLine = SAFE.hostLine; } })),
  ];
  const budget = Math.max(1500, deadline - Date.now());
  const ok = (t: string) => within(screenOutput(t, familySafe).then((v) => v.allowed).catch(() => false), budget, false);
  if (await ok(fields.map((f) => f.text).join('\n'))) return spec;
  const verdicts = await Promise.all(fields.map((f) => ok(f.text)));
  const out = structuredClone(spec);
  fields.forEach((f, i) => { if (!verdicts[i]) f.set(out); });
  log(`screening replaced ${verdicts.filter((v) => !v).length} field(s)`);
  return out;
}

// ---------------------------------------------------------------- pitches

const FALLBACK_PALETTES: Pitch['palette'][] = [
  { bg: '#1a1033', primary: '#ff6b9d', accent: '#4cc9f0', glow: '#ffd166', text: '#fff8f0' },
  { bg: '#0f2027', primary: '#2ec4b6', accent: '#ff9f1c', glow: '#cbf3f0', text: '#f7fff7' },
  { bg: '#2b1a12', primary: '#ff9f1c', accent: '#e63946', glow: '#ffd166', text: '#fff6e5' },
];

/** `p`, or `fallback` if it hasn't settled within `ms`. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((r) => { timer = setTimeout(() => r(fallback), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** Hand-made pitches from the ingredients, for slots the model left empty or broken. */
export function fallbackPitches(ingredients: string[]): Pitch[] {
  const ing = ingredients.map((i) => i.trim()).filter(Boolean);
  const a = ing[0] ?? 'snack';
  const b = ing[1] ?? 'grumpy cat';
  const c = ing[2] ?? a;
  const mk = (title: string, hook: string, art: string, blocksSketch: string[], i: number): Pitch => ({
    id: `p-${rand()}`,
    title: clip(titleCase(title), 40),
    hook: clip(hook, 120),
    keyArtPrompt: clip(`${art}, bright bold cartoon, no text`, 600),
    palette: FALLBACK_PALETTES[i % FALLBACK_PALETTES.length]!,
    blocksSketch,
  });
  return [
    mk(`${a} heist`, `Sneak past the ${b}. Grab the ${a}. Don't get caught.`, `A sleeping ${b} guarding a mountain of ${a}`, ['sneak', 'collect'], 0),
    mk(`${c} panic`, `${titleCase(c)} chaos: grab, dodge, and never stop moving.`, `Players scrambling for ${a} while ${c} rains from the sky`, ['arena-move', 'collect', 'dodge'], 1),
    mk(`${b} tug`, `Two teams, one rope, one very confused ${b}.`, `Two teams pulling a rope over a ${b}`, ['tug'], 2),
  ];
}

const RawPitch = z.object({
  title: z.string(),
  hook: z.string(),
  keyArtPrompt: z.string(),
  palette: z.unknown().optional(),
  blocksSketch: z.array(z.string()).optional(),
}).passthrough();

function cleanPitch(raw: unknown, i: number): Pitch | undefined {
  const r = RawPitch.safeParse(raw);
  if (!r.success) return undefined;
  const pal = PaletteSchema.safeParse(r.data.palette);
  const known = new Set(CATALOG.map((k) => k.id));
  const pitch: Pitch = {
    id: `p-${rand()}`,
    title: clip(r.data.title.trim(), 40),
    hook: clip(r.data.hook.trim(), 120),
    keyArtPrompt: clip(r.data.keyArtPrompt.trim(), 600),
    palette: pal.success ? pal.data : FALLBACK_PALETTES[i % FALLBACK_PALETTES.length]!,
    blocksSketch: (r.data.blocksSketch ?? []).filter((b) => known.has(b)).slice(0, 4),
  };
  return PitchSchema.safeParse(pitch).success ? pitch : undefined;
}

/** Three light pitches from one fast-model call. Always returns exactly 3 (fallbacks fill gaps). */
export async function pitch(
  ingredients: string[], players: string[], opts: { familySafe: boolean; deadlineMs: number },
): Promise<Pitch[]> {
  const deadline = toDeadline(opts.deadlineMs);
  let pitches: Pitch[] = [];
  try {
    const out = await call({
      model: 'fast',
      system: pitchSystemPrompt(opts.familySafe),
      messages: [{ role: 'user', content: [{ text: pitchUserPrompt(ingredients, players) }] }],
      maxTokens: 1500,
    }, deadline, 'pitch');
    const json = extractJson(out.text);
    const arr = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.pitches) ? json.pitches : [];
    pitches = arr.map(cleanPitch).filter((x): x is Pitch => !!x).slice(0, 3);
  } catch (e) {
    log('pitch failed; using fallbacks:', (e as Error)?.name, (e as Error)?.message);
  }
  if (pitches.length && opts.familySafe) {
    // Guardrails on generated text (fails closed): a blocked pitch is replaced by a fallback.
    const left = deadline - Date.now();
    const verdicts = await Promise.all(pitches.map((p) => within(
      screen(`${p.title}. ${p.hook}`, 'OUTPUT', true).then((v) => v.allowed).catch(() => false), left, false,
    )));
    pitches = pitches.filter((_, i) => verdicts[i]);
  }
  const fill = fallbackPitches(ingredients);
  for (let i = 0; pitches.length < 3; i++) pitches.push(fill[i % fill.length]!);
  return pitches;
}

// ---------------------------------------------------------------- remix

const RemixReply = z.object({
  patch: z.array(z.object({ op: z.string(), path: z.string(), value: z.unknown().optional(), from: z.string().optional() })),
  summary: z.string().optional(),
});

/**
 * Apply a room's remix request as a JSON patch. The result is a new spec (new id, parentId =
 * the original id) that validates and passes the bot playtest. One repair round if time allows.
 * Every failure (blocked request, deadline, unfixable patch) is a RemixFailed.
 */
export async function remix(spec: GameSpec, request: string, ctx: {
  deadlineMs: number; onProgress: (s: string) => void; familySafe?: boolean;
}): Promise<{ spec: GameSpec }> {
  const deadline = toDeadline(ctx.deadlineMs);
  const familySafe = ctx.familySafe ?? true;
  const progress = (s: string) => {
    try { ctx.onProgress(s); } catch { /* cosmetic */ }
  };
  progress('Reading the remix');
  const verdict = await within(
    screen(request, 'INPUT', familySafe).then((v) => v.allowed).catch(() => false),
    Math.max(0, deadline - Date.now()), false,
  );
  if (!verdict) throw new RemixFailed('blocked');

  const system = remixSystemPrompt();
  const id = newSpecId(spec.title);
  let errors: string[] | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && deadline - Date.now() < 2500) break;
      if (attempt > 0) progress('Fixing the remix');
      const out = await call({
        model: 'designer',
        system,
        messages: [{ role: 'user', content: [...withCache([{ text: REMIX_KICKOFF } as ContentBlock], CACHE_POINT), { text: remixPrompt(spec, request, errors) }] }],
        maxTokens: 1500,
      }, deadline, 'remix');
      const reply = RemixReply.safeParse(extractJson(out.text));
      if (!reply.success) {
        errors = ['reply was not {"patch": [...], "summary": "..."}'];
        continue;
      }
      progress('Rewriting the rules');
      let next: unknown;
      try {
        next = jsonpatch.applyPatch(structuredClone(spec), reply.data.patch as Operation[], true, false).newDocument;
      } catch (e) {
        errors = [`patch failed: ${(e as Error).message}`];
        continue;
      }
      next = stamp(next, { id, origin: { ...spec.origin, parentId: spec.id } });
      progress('Bots are playtesting');
      const { report, spec: parsed } = runPlaytest(next);
      if (report.ok && parsed) return { spec: await screenSpec(parsed, familySafe, deadline) };
      errors = report.reasons;
    }
  } catch (e) {
    if (e instanceof RemixFailed) throw e;
    throw new RemixFailed(e instanceof DesignTimeout ? 'deadline' : `remix failed: ${(e as Error)?.name}: ${(e as Error)?.message}`);
  }
  throw new RemixFailed(`remix failed: ${(errors ?? []).join(' | ')}`);
}
