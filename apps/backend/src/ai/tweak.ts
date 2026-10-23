import type { ContentBlock, Message, ToolResultBlock } from '@aws-sdk/client-bedrock-runtime';
import type { PlaytestReport } from '@cadabra/engine';
import {
  TWEAK_CHIPS, TWEAK_CHIP_LABELS, parseSpec, type GameSpec, type TweakChip, type TweakRequest,
} from '@cadabra/spec';
import { screen, screenOutput, type ToolSpec } from './bedrock';
import {
  CACHE_POINT, DesignTimeout, call, newSpecId, screenSpec, stamp, withCache, within,
} from './designer';
import { DESIGN_KICKOFF, designerSystemPrompt, tweakBrief } from './prompts';
import { CATALOG, TOOL_SPECS, runPlaytest, runTool, type ToolState } from './tools';

/**
 * TWEAK between rounds (and Remix from the Arcade): the room's chips / typed requests become a small
 * JSON patch on the current spec. The AI designer patches + playtests in one reply (≤ 8 s typical);
 * deterministic chip presets are the fallback (and the AI's starting hint). Never throws: the worst
 * case is the original spec back with source 'none'.
 */
export const TWEAK_BUDGET = {
  /** Hard cap for the whole tweak, from receipt. */
  totalMs: 15_000,
  /** The AI loop must end by then (presets + screening fit in the rest). */
  aiMs: 11_500,
  /** Max model replies. */
  maxTurns: 3,
  /** Input screening cap. */
  screenMs: 2500,
};

export interface TweakResult {
  spec: GameSpec;
  summary: string;
  changes: string[];
  source: 'ai' | 'preset' | 'none';
  blocked?: boolean;
  ms: number;
  report?: PlaytestReport;
  toolCalls?: number;
}

const log = (...a: unknown[]) => console.warn('[tweak]', ...a);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

// ---------------------------------------------------------------- presets

type Prop = { type?: string; minimum?: number; maximum?: number; default?: unknown };
const propOf = (block: string, param: string): Prop | undefined =>
  ((CATALOG.find((k) => k.id === block)?.params as { properties?: Record<string, Prop> })?.properties ?? {})[param];

const round = (v: number, p: Prop) => (p.type === 'integer' ? Math.round(v) : Math.round(v * 100) / 100);
const clamp = (v: number, p: Prop) => Math.min(p.maximum ?? Infinity, Math.max(p.minimum ?? -Infinity, v));

interface Draft { spec: GameSpec; tags: string[] }

/** Scale (or set) a numeric block param, clamped to the catalog range. True when it changed. */
function scale(d: Draft, block: string, param: string, f: (v: number) => number): boolean {
  const p = propOf(block, param);
  if (!p || (p.type !== 'number' && p.type !== 'integer')) return false;
  let hit = false;
  for (const b of [...d.spec.blocks, ...d.spec.modifiers]) {
    if (b.block !== block) continue;
    const cur = typeof b.params[param] === 'number' ? (b.params[param] as number) : typeof p.default === 'number' ? p.default : undefined;
    if (cur === undefined) continue;
    const next = round(clamp(f(cur), p), p);
    if (next !== cur) { b.params[param] = next; hit = true; }
  }
  return hit;
}
function set(d: Draft, block: string, param: string, value: unknown, only?: (params: Record<string, unknown>) => boolean): boolean {
  if (!propOf(block, param)) return false;
  let hit = false;
  for (const b of d.spec.blocks) {
    if (b.block !== block || (only && !only(b.params))) continue;
    if (b.params[param] !== value) { b.params[param] = value; hit = true; }
  }
  return hit;
}
const has = (d: Draft, block: string) => d.spec.blocks.some((b) => b.block === block);
const mode = (d: Draft, flag: string) => d.spec.blocks.some((b) => b.block === 'arena-move' && b.params[flag] === true);

/** World physics (R2 engine): scale a numeric field when the spec has a physics world. */
function physics(d: Draft, field: string, f: (v: number) => number, dflt: number, lo: number, hi: number): boolean {
  const s = d.spec as unknown as { world?: { physics?: Record<string, unknown> } };
  const ph = s.world?.physics;
  if (!isObj(ph)) return false;
  const cur = typeof ph[field] === 'number' ? (ph[field] as number) : dflt;
  const next = Math.round(Math.min(hi, Math.max(lo, f(cur))) * 100) / 100;
  if (next === cur) return false;
  ph[field] = next;
  return true;
}

const PRESETS: Record<TweakChip, (d: Draft) => void> = {
  'low-gravity': (d) => {
    const g = physics(d, 'gravityScale', (v) => v * 0.4, 1, 0, 3);
    const damp = physics(d, 'linearDamping', (v) => v * 0.35, 1, 0, 10);
    // Without a physics world: floaty means slidey (low friction, soft acceleration, longer dashes).
    const slide = scale(d, 'arena-move', 'friction', (v) => v * 0.5);
    scale(d, 'arena-move', 'accel', (v) => v * 0.8);
    scale(d, 'arena-move', 'dashMs', (v) => v * 1.25);
    const soft = scale(d, 'race', 'stumbleSec', (v) => v * 0.6);
    const drift = scale(d, 'dodge', 'hazardSpeed', (v) => v * 0.7);
    if (g) d.tags.push('Gravity ×0.4');
    else if (damp || slide || soft) d.tags.push('Floaty ↑');
    else if (drift) d.tags.push('Hazards drift');
  },
  faster: (d) => {
    let hit = false;
    hit = scale(d, 'arena-move', 'speed', (v) => v * 1.3) || hit;
    hit = scale(d, 'arena-move', 'accel', (v) => v * 1.3) || hit;
    hit = scale(d, 'arena-move', 'dashCooldownSec', (v) => v * 0.75) || hit;
    hit = scale(d, 'collect', 'spawnEverySec', (v) => v * 0.75) || hit;
    hit = scale(d, 'dodge', 'hazardSpeed', (v) => v * 1.25) || hit;
    hit = scale(d, 'dodge', 'startRate', (v) => v * 1.2) || hit;
    hit = scale(d, 'race', 'runSpeed', (v) => v * 1.25) || hit;
    hit = scale(d, 'race', 'mashPower', (v) => v * 1.2) || hit;
    hit = scale(d, 'sneak', 'chaseSpeed', (v) => v * 1.2) || hit;
    hit = scale(d, 'tug', 'rhythmBpm', (v) => v * 1.2) || hit;
    hit = scale(d, 'trivia', 'secondsPerQuestion', (v) => v * 0.75) || hit;
    hit = scale(d, 'draw-judge', 'drawSec', (v) => v * 0.75) || hit;
    if (hit) d.tags.push('Speed ×1.3');
  },
  'bigger-arena': (d) => {
    let hit = false;
    hit = scale(d, 'arena-move', 'ringRadius', (v) => v * 1.2) || hit;
    hit = scale(d, 'arena-move', 'ringShrinkTo', (v) => v * 1.2) || hit;
    hit = scale(d, 'arena-move', 'avatarScale', (v) => v * 0.85) || hit;
    hit = scale(d, 'arena-move', 'paintCols', (v) => v + 4) || hit;
    hit = scale(d, 'arena-move', 'paintRows', (v) => v + 2) || hit;
    hit = scale(d, 'collect', 'spawnRadius', (v) => v * 1.25) || hit;
    hit = scale(d, 'collect', 'maxItems', (v) => v + 3) || hit;
    hit = scale(d, 'race', 'trackLength', (v) => v * 1.25) || hit;
    hit = scale(d, 'tug', 'ropeLength', (v) => v * 1.2) || hit;
    hit = scale(d, 'sneak', 'hearingRadius', (v) => v * 0.85) || hit;
    if (hit) d.tags.push('Arena ↑');
  },
  bouncier: (d) => {
    const r = physics(d, 'restitution', (v) => Math.max(v + 0.35, v * 1.6), 0.4, 0, 1.2);
    let hit = r;
    hit = scale(d, 'arena-move', 'dashShove', (v) => v * 1.4) || hit;
    hit = set(d, 'arena-move', 'bounceWalls', true, (p) => p.ringOut !== true) || hit;
    hit = scale(d, 'dodge', 'hitKnockback', (v) => Math.max(400, v * 1.5)) || hit;
    hit = scale(d, 'arena-move', 'friction', (v) => v * 0.75) || hit;
    // Lanes: springier boost pads, quicker recovery from a stumble.
    hit = scale(d, 'race', 'padBoost', (v) => v * 1.3) || hit;
    hit = scale(d, 'race', 'stumbleSec', (v) => v * 0.7) || hit;
    if (hit) d.tags.push('Bounce ↑');
  },
  'more-chaos': (d) => {
    let hit = false;
    hit = scale(d, 'collect', 'maxItems', (v) => v * 1.5) || hit;
    hit = scale(d, 'collect', 'spawnEverySec', (v) => v * 0.7) || hit;
    hit = scale(d, 'collect', 'goldenChance', (v) => Math.max(0.2, v * 2)) || hit;
    hit = scale(d, 'dodge', 'maxRate', (v) => v * 1.35) || hit;
    hit = scale(d, 'dodge', 'rampPerSec', (v) => v * 1.5) || hit;
    hit = scale(d, 'race', 'obstacleDensity', (v) => v + 0.15) || hit;
    hit = scale(d, 'race', 'boostPads', (v) => v + 2) || hit;
    if (mode(d, 'overload')) hit = scale(d, 'arena-move', 'overloadCores', (v) => v + 1) || hit;
    hit = scale(d, 'arena-move', 'dashCooldownSec', (v) => v * 0.7) || hit;
    hit = scale(d, 'arena-move', 'dashShove', (v) => v * 1.2) || hit;
    hit = scale(d, 'sneak', 'guardCount', (v) => v + 1) || hit;
    hit = scale(d, 'tug', 'fatigue', (v) => v * 0.5) || hit;
    hit = physics(d, 'knockback', (v) => v * 1.3, 1, 0, 4) || hit;
    if (hit) d.tags.push('Chaos ↑');
  },
  'harder-for-leader': (d) => {
    const before = d.spec.comeback.strength;
    d.spec.comeback = { enabled: true, strength: Math.min(1, Math.max(0.6, before + 0.25)) };
    if (mode(d, 'paint')) set(d, 'arena-move', 'paintUnderdog', true);
    if (has(d, 'tug')) scale(d, 'tug', 'underdogBoost', (v) => Math.max(0.6, v + 0.4));
    d.tags.push('Comeback ↑');
  },
};

/** Free text -> the chips it obviously asks for (fallback when the AI is unavailable). */
export function chipsFromText(text: string): TweakChip[] {
  const t = text.toLowerCase();
  const out: TweakChip[] = [];
  if (/gravit|floaty|float|moon|space|zero.?g|slipp|ice|icy/.test(t)) out.push('low-gravity');
  if (/fast|speed|quick|turbo|hyper|zoom/.test(t)) out.push('faster');
  if (/big|large|huge|giant|massive|wide|arena|room|space to/.test(t)) out.push('bigger-arena');
  if (/bounc|rubber|pinball|boing|jelly|spring/.test(t)) out.push('bouncier');
  if (/chao|crazy|wild|mayhem|insane|more stuff|madness|explo|frenz/.test(t)) out.push('more-chaos');
  if (/leader|winning|first place|unfair|catch.?up|comeback|harder for/.test(t)) out.push('harder-for-leader');
  return out;
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

/**
 * Deterministic chip presets: apply each chip's patch, playtest the combination; if it fails, keep the
 * largest prefix of chips that passes. Returns undefined when no chip changes anything playable.
 */
export function presetTweak(spec: GameSpec, chips: TweakChip[], opts: { players?: number } = {}): {
  spec: GameSpec; changes: string[]; summary: string; report: PlaytestReport;
} | undefined {
  const list = uniq(chips).filter((c) => (TWEAK_CHIPS as readonly string[]).includes(c));
  for (let n = list.length; n > 0; n--) {
    const d: Draft = { spec: structuredClone(spec), tags: [] };
    for (const c of list.slice(0, n)) PRESETS[c](d);
    if (!d.tags.length) continue;
    const { report, spec: parsed } = runPlaytest(d.spec, opts.players ?? 4);
    if (report.ok && parsed) {
      const changes = uniq(d.tags).slice(0, 4);
      return { spec: parsed, changes, summary: changes.join(', '), report };
    }
  }
  return undefined;
}

/** JSON patch ops between two specs (shallow on blocks' params), as the AI's starting hint. */
export function presetHint(spec: GameSpec, chips: TweakChip[]): { op: 'replace' | 'add'; path: string; value: unknown }[] {
  if (!chips.length) return [];
  const d: Draft = { spec: structuredClone(spec), tags: [] };
  for (const c of uniq(chips)) PRESETS[c](d);
  const ops: { op: 'replace' | 'add'; path: string; value: unknown }[] = [];
  d.spec.blocks.forEach((b, i) => {
    for (const [k, v] of Object.entries(b.params)) {
      const old = spec.blocks[i]?.params[k];
      if (JSON.stringify(old) !== JSON.stringify(v)) ops.push({ op: old === undefined ? 'add' : 'replace', path: `/blocks/${i}/params/${k}`, value: v });
    }
  });
  if (JSON.stringify(d.spec.comeback) !== JSON.stringify(spec.comeback)) ops.push({ op: 'replace', path: '/comeback', value: d.spec.comeback });
  const w0 = (spec as unknown as { world?: unknown }).world;
  const w1 = (d.spec as unknown as { world?: unknown }).world;
  if (w1 !== undefined && JSON.stringify(w0) !== JSON.stringify(w1)) ops.push({ op: w0 === undefined ? 'add' : 'replace', path: '/world', value: w1 });
  return ops;
}

// ---------------------------------------------------------------- AI tweak

/** The tool subset a tweak needs (same specs as the designer, so the cached prefix is shared). */
const TWEAK_TOOLS: ToolSpec[] = TOOL_SPECS;

/** Fields a player sees: if none changed, the output screen can be skipped. */
const visibleText = (s: GameSpec) => JSON.stringify([s.title, s.hook, s.host, s.timeline.map((e) => e.hostLine)]);

async function aiTweak(spec: GameSpec, chips: TweakChip[], texts: string[], ctx: {
  deadline: number; players: number; progress: (s: string) => void; mode: 'tweak' | 'remix';
}): Promise<{ spec: GameSpec; report: PlaytestReport; summary?: string; changes?: string[]; toolCalls: number }> {
  const id = newSpecId(spec.title);
  const origin = { ...spec.origin, parentId: spec.id };
  const state: ToolState = {
    normalize: (s) => stamp(s, { id, origin }), players: ctx.players, compactPatchResult: true,
  };
  state.current = state.normalize(structuredClone(spec));
  const brief = tweakBrief(spec, {
    requests: [...chips.map((c) => `${TWEAK_CHIP_LABELS[c]} (chip)`), ...texts.map((t) => JSON.stringify(t))],
    hint: presetHint(spec, chips), mode: ctx.mode,
  });
  const messages: Message[] = [
    { role: 'user', content: [...withCache([{ text: DESIGN_KICKOFF } as ContentBlock], CACHE_POINT), { text: brief }] },
  ];
  const tools = withCache(TWEAK_TOOLS, CACHE_POINT as unknown as ToolSpec);
  let toolCalls = 0;
  const original = state.current;
  /** A passing playtest of a patched spec (not the original) is the answer. */
  const accepted = () => (state.passing && state.passing.from === state.current && state.current !== original ? state.passing : undefined);

  for (let turn = 0; turn < TWEAK_BUDGET.maxTurns; turn++) {
    const out = await call({ model: 'designer', system: designerSystemPrompt(), messages, tools, maxTokens: 1500 }, ctx.deadline, 'tweak');
    const content: ContentBlock[] = [];
    if (out.text.trim()) content.push({ text: out.text });
    for (const tu of out.toolUses) content.push({ toolUse: tu });
    if (!content.length) content.push({ text: '(no reply)' });
    messages.push({ role: 'assistant', content });
    if (!out.toolUses.length) {
      messages.push({ role: 'user', content: [{ text: 'Use the tools: patch_spec (with summary and changes), then playtest_spec, in one reply.' }] });
      continue;
    }
    const results: ContentBlock[] = [];
    for (const tu of out.toolUses) {
      const name = tu.name ?? '';
      if (name === 'patch_spec') ctx.progress('Rewriting the rules');
      if (name === 'playtest_spec' || name === 'submit_spec') ctx.progress('Bots are playtesting');
      const r = runTool(name, tu.input, state);
      toolCalls++;
      if (r.submitted && state.current !== original) {
        return { ...r.submitted, summary: state.summary, changes: state.changes, toolCalls };
      }
      const block: ToolResultBlock = { toolUseId: tu.toolUseId!, content: [{ text: JSON.stringify(r.result) }], status: r.status };
      results.push({ toolResult: block });
    }
    const ok = accepted();
    if (ok) return { spec: ok.spec, report: ok.report, summary: state.summary, changes: state.changes, toolCalls };
    if (Date.now() >= ctx.deadline) break;
    messages.push({ role: 'user', content: [...results, { text: 'Fix every reason with one patch_spec (keep summary/changes current), then playtest_spec, in this reply.' }] });
  }
  throw new DesignTimeout('tweak: no passing patch');
}

/** Summary and change tags from the agent, cleaned; preset tags when it gave none. */
function cleanSummary(summary: string | undefined, changes: string[] | undefined): { summary: string; changes: string[] } {
  const tags = (changes ?? []).map((c) => clip(c.replace(/\s+/g, ' ').trim(), 24)).filter(Boolean).slice(0, 4);
  const line = clip((summary ?? '').replace(/\s+/g, ' ').trim(), 80) || tags.join(', ') || 'Rules remixed';
  return { summary: line, changes: tags.length ? tags : [clip(line, 24)] };
}

/** One tweak for the room. Never throws. */
export async function tweak(spec: unknown, requests: TweakRequest[], ctx: {
  familySafe?: boolean; seats?: number; mode?: 'tweak' | 'remix'; onProgress?: (step: string) => void;
  /** Absolute epoch-ms hard stop (default: now + TWEAK_BUDGET.totalMs). */
  hardStop?: number;
  /** Test hook: skip the AI (presets only). */
  ai?: boolean;
}): Promise<TweakResult> {
  const t0 = Date.now();
  const hardStop = ctx.hardStop ?? t0 + TWEAK_BUDGET.totalMs;
  const familySafe = ctx.familySafe ?? true;
  const players = Math.min(4, Math.max(2, ctx.seats ?? 4));
  const progress = (s: string) => { try { ctx.onProgress?.(s); } catch { /* cosmetic */ } };
  const parsed = parseSpec(spec);
  if (!parsed.ok) {
    log('invalid spec:', parsed.errors.slice(0, 3).join(' | '));
    throw new Error('tweak: invalid spec');
  }
  const base = parsed.spec;
  const unchanged = (blocked?: boolean): TweakResult => ({
    spec: base, summary: 'Same game, new round', changes: [], source: 'none', ms: Date.now() - t0, ...(blocked ? { blocked } : {}),
  });

  progress('Reading the requests');
  let chips = uniq(requests.flatMap((r) => ('chip' in r ? [r.chip] : [])));
  const typed = uniq(requests.flatMap((r) => ('text' in r ? [r.text.trim()] : [])).filter(Boolean)).slice(0, 3);
  // Typed text is screened (fails closed); a blocked request is dropped, the rest still apply.
  const verdicts = await Promise.all(typed.map((t) => within(
    screen(t, 'INPUT', familySafe).then((v) => v.allowed).catch(() => false), Math.min(TWEAK_BUDGET.screenMs, hardStop - Date.now()), false,
  )));
  const texts = typed.filter((_, i) => verdicts[i]);
  const blocked = texts.length < typed.length;
  if (!chips.length && !texts.length) return unchanged(blocked);

  // AI first, with the chip presets as its starting hint; presets are the fallback.
  if (ctx.ai !== false) {
    const deadline = Math.min(t0 + TWEAK_BUDGET.aiMs, hardStop - 2500);
    try {
      const r = await aiTweak(base, chips, texts, { deadline, players, progress, mode: ctx.mode ?? 'tweak' });
      const { summary, changes } = cleanSummary(r.summary, r.changes);
      // Guardrails on what players will read: changed host text plus the summary (one batched call).
      const screenBy = Math.max(Date.now() + 1500, hardStop - 500);
      const lineOk = await within(screenOutput(`${summary}\n${changes.join('\n')}`, familySafe).then((v) => v.allowed).catch(() => false),
        screenBy - Date.now(), false);
      const out = visibleText(r.spec) === visibleText(base) ? r.spec : await screenSpec(r.spec, familySafe, screenBy);
      const safe = lineOk ? { summary, changes } : { summary: 'Rules remixed', changes: ['Remixed'] };
      return { spec: out, ...safe, source: 'ai', ms: Date.now() - t0, report: r.report, toolCalls: r.toolCalls, ...(blocked ? { blocked } : {}) };
    } catch (e) {
      log(`ai tweak failed (${Date.now() - t0} ms): ${(e as Error)?.name}: ${(e as Error)?.message}`);
    }
  }

  progress('Applying presets');
  for (const t of texts) chips = uniq([...chips, ...chipsFromText(t)]);
  const p = presetTweak(base, chips, { players });
  if (!p) return unchanged(blocked);
  const out = structuredClone(p.spec);
  out.id = newSpecId(base.title);
  out.origin = { ...base.origin, parentId: base.id };
  return { spec: out, summary: p.summary, changes: p.changes, source: 'preset', ms: Date.now() - t0, report: p.report, ...(blocked ? { blocked } : {}) };
}
