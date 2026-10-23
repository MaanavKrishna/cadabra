import type { ContentBlock, Message, ToolResultBlock } from '@aws-sdk/client-bedrock-runtime';
import jsonpatch, { type Operation } from 'fast-json-patch';
import { z } from 'zod';
import type { PlaytestReport } from '@cadabra/engine';
import { PaletteSchema, PitchSchema, THEME_LOOKS, THEME_PALETTES, type GameSpec, type Pitch, type ThemeLook } from '@cadabra/spec';
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
export const CACHE_POINT = { cachePoint: { type: 'default' } } as unknown as ContentBlock;
const log = (...a: unknown[]) => console.warn('[designer]', ...a);
/** Test hook: re-enable prompt caching after a test disabled it. */
export function _resetPromptCache(): void { cacheEnabled = process.env.CADABRA_PROMPT_CACHE !== '0'; }

/**
 * `deadlineMs` is a budget in ms from now (e.g. 25000). An absolute epoch-ms timestamp
 * (anything after the year 2001) is accepted too.
 */
const toDeadline = (deadlineMs: number) => (deadlineMs > 1e12 ? deadlineMs : Date.now() + deadlineMs);

/** converse() raced against the deadline, so a hung call can't overrun it. */
export async function call(req: Omit<ConverseRequest, 'timeoutMs'>, deadline: number, what: string): Promise<ConverseOutput> {
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

export const withCache = <T>(blocks: T[], cache: T): T[] => (cacheEnabled ? [...blocks, cache] : blocks);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';
const rand = () => Math.random().toString(36).slice(2, 7);
export const newSpecId = (title: string) => `${slug(title)}-${rand()}`;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function stamp(spec: unknown, fields: { id: string; origin: GameSpec['origin']; look?: ThemeLook }): unknown {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const s = { ...(spec as Record<string, unknown>) };
  s.version = 1;
  s.id = fields.id;
  s.origin = fields.origin;
  if (s.modifiers === undefined) s.modifiers = [];
  // The sound set always follows the look (neon when the model gave none or an unknown one).
  if (isObj(s.theme)) {
    const look = (THEME_LOOKS as readonly unknown[]).includes(s.theme.look) ? (s.theme.look as ThemeLook) : (fields.look ?? 'neon');
    s.theme = { ...s.theme, look, sfxSet: look };
  }
  return s;
}

/** A pitch may carry the look the pitch model chose (kept in-process; the TV ignores the extra key). */
export type LookPitch = Pitch & { look?: ThemeLook };

const LOOK_WORDS: [ThemeLook, RegExp][] = [
  ['cosmos', /\b(?:space|star|planet|alien|moon|galax|rocket|comet|astro|orbit|nebula|ufo|magic|wizard|witch|dream|ocean|deep sea|night sky|cosmic)/],
  ['retro', /\b(?:8.?bit|pixel|retro|arcade classic|robot|dungeon|knight|dragon|ninja|castle|console|joystick|cassette|80s|vhs|pirate)/],
  ['toybox', /\b(?:lego|toy|brick|block|food|pizza|cake|candy|sweet|fruit|mango|banana|kitchen|school|cat|dog|duck|penguin|bear|animal|pet|farm|sport|soccer|football|ball|hockey|golf|bath|jelly|teddy|dino|ladoo|chai|tea\b|cookie|donut|burger)/],
  ['neon', /\b(?:neon|laser|cyber|synth|disco|glow|tron|light|night city|hacker|race|racing|music|dj|electric)/],
];
/** The look that fits a set of ingredients (keyword heuristic for fallbacks; the AI chooses otherwise). */
export function lookFor(words: readonly string[]): ThemeLook {
  const t = words.join(' ').toLowerCase();
  for (const [look, re] of LOOK_WORDS) if (re.test(t)) return look;
  return 'neon';
}
/** Dark-background looks need light text and vice versa. */
export const paletteFits = (look: ThemeLook, bg: string) => {
  const n = parseInt(bg.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return look === 'toybox' ? lum > 0.6 : lum < 0.35;
};

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
      const sprites = blocks.flatMap((b) => [b.params?.guardSprite, b.params?.hazardSprite, b.params?.itemSprite, b.params?.obstacleSprite])
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
  /** Seats in the round incl. bots (default: players.length); sets the playtest head count. */
  seats?: number;
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
  const look = (p as LookPitch).look ?? lookFor([...ctx.ingredients, p.title]);
  const state: ToolState = { normalize: (s) => stamp(s, { id, origin, look }), players: Math.min(4, Math.max(2, ctx.seats ?? ctx.players.length)) };
  const familySafe = ctx.familySafe ?? true;
  const system = designerSystemPrompt();
  const brief = designBrief({ ...p, look }, {
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
        if (process.env.CADABRA_DEBUG) log(`turn ${turn} ${name} ${r.status}`, r.status === 'error' ? JSON.stringify(r.result).slice(0, 600) : '');
        if (r.submitted) return await finish(r.submitted);
        const block: ToolResultBlock = {
          toolUseId: tu.toolUseId!,
          content: [{ text: JSON.stringify(r.result) }],
          status: r.status,
        };
        results.push({ toolResult: block });
      }
      // The latest spec just passed the bot playtest: that is the submission (saves a model round trip).
      if (state.passing && state.passing.from === state.current) {
        progress('Final bot playtest');
        return await finish(state.passing);
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

/** Neon arcade palettes (deep navy + neon), rotated across the hand-made pitches. */
const LOOK_ART: Record<ThemeLook, string> = {
  neon: 'glowing neon vector arcade style on a deep navy void',
  toybox: 'glossy plastic toy diorama on a clean light play table, bright primaries, soft shadows',
  cosmos: 'deep-space arena with a starfield and nebula glow, little astronaut orbs',
  retro: 'crisp 8-bit pixel-art arcade scene, chunky pixels, CRT colours',
};

/** `p`, or `fallback` if it hasn't settled within `ms`. */
export async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((r) => { timer = setTimeout(() => r(fallback), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** Hand-made pitches from the ingredients, for slots the model left empty or broken (three different looks). */
export function fallbackPitches(ingredients: string[]): LookPitch[] {
  const ing = ingredients.map((i) => i.trim()).filter(Boolean);
  const a = ing[0] ?? 'star';
  const b = ing[1] ?? 'comet';
  const c = ing[2] ?? a;
  const first = lookFor(ing);
  const looks: ThemeLook[] = [first, first === 'cosmos' ? 'toybox' : 'cosmos', first === 'retro' ? 'neon' : 'retro'];
  const mk = (title: string, hook: string, art: string, blocksSketch: string[], i: number): LookPitch => ({
    id: `p-${rand()}`,
    title: clip(titleCase(title), 40),
    hook: clip(hook, 120),
    keyArtPrompt: clip(`${art}, ${LOOK_ART[looks[i]!]}, no text`, 600),
    palette: { ...THEME_PALETTES[looks[i]!] },
    blocksSketch,
    look: looks[i]!,
  });
  return [
    mk(`${a} ring out`, `A floating ${a} arena is crumbling. Bump rivals off the edge, stay on!`, `A floating ring arena shaped like a ${a}, edge tiles breaking away, four players colliding`, ['arena-move'], 0),
    mk(`${b} core rush`, `Carry ${b} cores to your base. Dash carriers to knock them loose.`, `${b}-shaped cores between two team bases, players racing and bumping`, ['arena-move', 'collect'], 1),
    mk(`${c} gate dash`, `A four-lane race through ${c} gates. Mash, jump the live ones, win.`, `Four racing lanes with pulsing ${c}-shaped gates and a bright finish line`, ['race'], 2),
  ];
}

const RawPitch = z.object({
  title: z.string(),
  hook: z.string(),
  keyArtPrompt: z.string(),
  palette: z.unknown().optional(),
  look: z.unknown().optional(),
  blocksSketch: z.array(z.string()).optional(),
}).passthrough();

const LOOK_CYCLE: ThemeLook[] = ['neon', 'toybox', 'cosmos', 'retro'];

function cleanPitch(raw: unknown, i: number): LookPitch | undefined {
  const r = RawPitch.safeParse(raw);
  if (!r.success) return undefined;
  const look: ThemeLook = (THEME_LOOKS as readonly unknown[]).includes(r.data.look) ? (r.data.look as ThemeLook) : LOOK_CYCLE[i % LOOK_CYCLE.length]!;
  const pal = PaletteSchema.safeParse(r.data.palette);
  const known = new Set(CATALOG.map((k) => k.id));
  const pitch: LookPitch = {
    id: `p-${rand()}`,
    title: clip(r.data.title.trim(), 40),
    hook: clip(r.data.hook.trim(), 120),
    keyArtPrompt: clip(r.data.keyArtPrompt.trim(), 600),
    // A palette that clashes with the look (dark toybox, light cosmos) falls back to the look's default.
    palette: pal.success && paletteFits(look, pal.data.bg) ? pal.data : { ...THEME_PALETTES[look] },
    blocksSketch: (r.data.blocksSketch ?? []).filter((b) => known.has(b)).slice(0, 4),
    look,
  };
  return PitchSchema.safeParse(pitch).success ? pitch : undefined;
}

const PITCH_SCREEN_RESERVE_MS = 1200;

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
      // Leave time to screen the pitches before the deadline.
    }, opts.familySafe ? Math.max(Date.now() + 1, deadline - PITCH_SCREEN_RESERVE_MS) : deadline, 'pitch');
    const json = extractJson(out.text);
    const arr = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.pitches) ? json.pitches : [];
    pitches = arr.map(cleanPitch).filter((x): x is LookPitch => !!x).slice(0, 3);
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
