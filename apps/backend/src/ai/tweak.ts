import type { ContentBlock, Message, ToolResultBlock } from '@aws-sdk/client-bedrock-runtime';
import type { PlaytestReport } from '@cadabra/engine';
import {
  PHYSICS_DEFAULTS, TWEAK_CHIPS, TWEAK_CHIP_LABELS, parseSpec, type GameSpec, type TweakChip, type TweakRequest,
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

/** k: preset strength (1 = full; 0.5 = the gentler retry when the full preset fails playtest). */
interface Draft { spec: GameSpec; tags: string[]; k: number }

/** Multiply by `f` at strength k (f=1.3, k=0.5 -> 1.15). */
const mul = (d: Draft, f: number) => (v: number) => v * (1 + (f - 1) * d.k);
/** Add `n` at strength k (rounded by the param type later). */
const add = (d: Draft, n: number) => (v: number) => v + n * d.k;

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

/** The spec's physics world when physics is on (world.physics present and not disabled). */
function world(d: Draft): Record<string, unknown> | undefined {
  const ph = d.spec.world?.physics as Record<string, unknown> | undefined;
  return isObj(ph) && ph.enabled !== false ? ph : undefined;
}
/** Scale a numeric world.physics field (default from PHYSICS_DEFAULTS), clamped to the schema range. */
function physics(d: Draft, field: keyof typeof PHYSICS_DEFAULTS, f: (v: number) => number): boolean {
  const ph = world(d);
  const lim = PHYSICS_RANGE[field];
  if (!ph || !lim) return false;
  const cur = typeof ph[field] === 'number' ? (ph[field] as number) : (PHYSICS_DEFAULTS[field] as number);
  const next = Math.round(Math.min(lim[1], Math.max(lim[0], f(cur))) * 100) / 100;
  if (next === cur) return false;
  ph[field] = next;
  return true;
}
const PHYSICS_RANGE: Partial<Record<keyof typeof PHYSICS_DEFAULTS, [number, number]>> = {
  gravityX: [-1500, 1500], gravityY: [-1500, 1500], restitution: [0, 1.2], friction: [0, 1], linearDamping: [0, 10],
  angularDamping: [0, 10], playerMass: [0.25, 4], knockback: [0.25, 4], bumperKick: [0, 1500], barrelPower: [0, 2500],
};
const propCount = (d: Draft) => (d.spec.world?.props ?? []).reduce((n, p) => n + p.count, 0);

const PRESETS: Record<TweakChip, (d: Draft) => void> = {
  'low-gravity': (d) => {
    const ph = world(d);
    const tilted = !!ph && (Number(ph.gravityX ?? 0) !== 0 || Number(ph.gravityY ?? 0) !== 0);
    const g = physics(d, 'gravityX', mul(d, 0.4)) || physics(d, 'gravityY', mul(d, 0.4));
    // Top-down physics: floaty = bodies drift (low damping), players are light, spins last.
    const damp = physics(d, 'linearDamping', mul(d, 0.3));
    physics(d, 'angularDamping', mul(d, 0.4));
    physics(d, 'playerMass', mul(d, 0.7));
    // Classic movement: floaty means slidey (low friction, soft acceleration, longer dashes).
    const slide = scale(d, 'arena-move', 'friction', mul(d, 0.5));
    scale(d, 'arena-move', 'accel', mul(d, 0.8));
    scale(d, 'arena-move', 'dashMs', mul(d, 1.25));
    const soft = scale(d, 'race', 'stumbleSec', mul(d, 0.6));
    const drift = scale(d, 'dodge', 'hazardSpeed', mul(d, 0.7));
    if (g && tilted) d.tags.push(`Gravity ×${Math.round((1 - 0.6 * d.k) * 10) / 10}`);
    if (damp) d.tags.push('Floaty ↑');
    else if (slide || soft) d.tags.push('Slidey ↑');
    else if (drift) d.tags.push('Hazards drift');
  },
  faster: (d) => {
    let hit = false;
    hit = scale(d, 'arena-move', 'speed', mul(d, 1.3)) || hit;
    hit = scale(d, 'arena-move', 'accel', mul(d, 1.3)) || hit;
    hit = scale(d, 'arena-move', 'dashCooldownSec', mul(d, 0.75)) || hit;
    hit = scale(d, 'collect', 'spawnEverySec', mul(d, 0.75)) || hit;
    hit = scale(d, 'dodge', 'hazardSpeed', mul(d, 1.25)) || hit;
    hit = scale(d, 'dodge', 'startRate', mul(d, 1.2)) || hit;
    hit = scale(d, 'race', 'runSpeed', mul(d, 1.25)) || hit;
    hit = scale(d, 'race', 'mashPower', mul(d, 1.2)) || hit;
    hit = scale(d, 'sneak', 'chaseSpeed', mul(d, 1.2)) || hit;
    hit = scale(d, 'tug', 'rhythmBpm', mul(d, 1.2)) || hit;
    hit = scale(d, 'trivia', 'secondsPerQuestion', mul(d, 0.75)) || hit;
    hit = scale(d, 'draw-judge', 'drawSec', mul(d, 0.75)) || hit;
    hit = physics(d, 'linearDamping', mul(d, 0.8)) || hit;
    if (hit) d.tags.push(`Speed ×${Math.round((1 + 0.3 * d.k) * 100) / 100}`);
  },
  'bigger-arena': (d) => {
    let hit = false;
    hit = scale(d, 'arena-move', 'ringRadius', mul(d, 1.2)) || hit;
    hit = scale(d, 'arena-move', 'ringShrinkTo', mul(d, 1.2)) || hit;
    hit = scale(d, 'arena-move', 'avatarScale', mul(d, 0.85)) || hit;
    hit = scale(d, 'arena-move', 'paintCols', add(d, 4)) || hit;
    hit = scale(d, 'arena-move', 'paintRows', add(d, 2)) || hit;
    hit = scale(d, 'collect', 'spawnRadius', mul(d, 1.25)) || hit;
    hit = scale(d, 'collect', 'maxItems', add(d, 3)) || hit;
    hit = scale(d, 'race', 'trackLength', mul(d, 1.25)) || hit;
    hit = scale(d, 'tug', 'ropeLength', mul(d, 1.2)) || hit;
    hit = scale(d, 'sneak', 'hearingRadius', mul(d, 0.85)) || hit;
    for (const p of d.spec.world?.props ?? []) {
      if (p.layout === 'ring' && p.radius !== undefined) { p.radius = Math.min(500, Math.round(p.radius * (1 + 0.2 * d.k))); hit = true; }
    }
    if (hit) d.tags.push('Arena ↑');
  },
  bouncier: (d) => {
    let hit = physics(d, 'restitution', (v) => v + Math.max(0.25, v * 0.5) * d.k);
    hit = physics(d, 'knockback', mul(d, 1.3)) || hit;
    hit = physics(d, 'bumperKick', mul(d, 1.3)) || hit;
    hit = scale(d, 'arena-move', 'dashShove', mul(d, 1.4)) || hit;
    hit = set(d, 'arena-move', 'bounceWalls', true, (p) => p.ringOut !== true) || hit;
    hit = scale(d, 'dodge', 'hitKnockback', (v) => Math.max(400 * d.k, v * (1 + 0.5 * d.k))) || hit;
    hit = scale(d, 'arena-move', 'friction', mul(d, 0.75)) || hit;
    // Lanes: springier boost pads, quicker recovery from a stumble.
    hit = scale(d, 'race', 'padBoost', mul(d, 1.3)) || hit;
    hit = scale(d, 'race', 'stumbleSec', mul(d, 0.7)) || hit;
    if (hit) d.tags.push('Bounce ↑');
  },
  'more-chaos': (d) => {
    let hit = false;
    hit = scale(d, 'collect', 'maxItems', mul(d, 1.5)) || hit;
    hit = scale(d, 'collect', 'spawnEverySec', mul(d, 0.7)) || hit;
    hit = scale(d, 'collect', 'goldenChance', (v) => Math.max(0.2 * d.k, v * (1 + d.k))) || hit;
    hit = scale(d, 'dodge', 'maxRate', mul(d, 1.35)) || hit;
    hit = scale(d, 'dodge', 'rampPerSec', mul(d, 1.5)) || hit;
    hit = scale(d, 'race', 'obstacleDensity', add(d, 0.15)) || hit;
    hit = scale(d, 'race', 'boostPads', add(d, 2)) || hit;
    if (mode(d, 'overload')) hit = scale(d, 'arena-move', 'overloadCores', add(d, 1)) || hit;
    hit = scale(d, 'arena-move', 'dashCooldownSec', mul(d, 0.7)) || hit;
    hit = scale(d, 'arena-move', 'dashShove', mul(d, 1.2)) || hit;
    hit = scale(d, 'sneak', 'guardCount', add(d, 1)) || hit;
    hit = scale(d, 'tug', 'fatigue', mul(d, 0.5)) || hit;
    hit = physics(d, 'knockback', mul(d, 1.3)) || hit;
    // A physics arena gets explosive barrels (within the 40-prop cap).
    if (world(d) && d.spec.arena.kind === 'topdown' && d.k >= 1 && propCount(d) + 3 <= 40 && (d.spec.world?.props?.length ?? 0) < 4
      && !(d.spec.world?.props ?? []).some((p) => p.kind === 'barrel')) {
      d.spec.world!.props = [...(d.spec.world!.props ?? []), { kind: 'barrel', count: 3, layout: 'scatter', respawnSec: 6 }];
      d.tags.push('Barrels!');
      hit = true;
    }
    if (hit) d.tags.push('Chaos ↑');
  },
  'harder-for-leader': (d) => {
    const before = d.spec.comeback.strength;
    d.spec.comeback = { enabled: true, strength: Math.min(1, Math.max(0.6, before + 0.25 * d.k)) };
    if (mode(d, 'paint')) set(d, 'arena-move', 'paintUnderdog', true);
    if (has(d, 'tug')) scale(d, 'tug', 'underdogBoost', (v) => Math.max(0.6, v + 0.4 * d.k));
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
  // Full strength first, then a gentler version, then fewer chips.
  for (let n = list.length; n > 0; n--) {
    for (const k of [1, 0.5]) {
      const d: Draft = { spec: structuredClone(spec), tags: [], k };
      for (const c of list.slice(0, n)) PRESETS[c](d);
      if (!d.tags.length) continue;
      const { report, spec: parsed } = runPlaytest(d.spec, opts.players ?? 4);
      if (report.ok && parsed) {
        const changes = uniq(d.tags).slice(0, 4);
        return { spec: parsed, changes, summary: changes.join(', '), report };
      }
    }
  }
  return undefined;
}

/** JSON patch ops between two specs (shallow on blocks' params), as the AI's starting hint. */
export function presetHint(spec: GameSpec, chips: TweakChip[]): { op: 'replace' | 'add'; path: string; value: unknown }[] {
  if (!chips.length) return [];
  const d: Draft = { spec: structuredClone(spec), tags: [], k: 1 };
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
