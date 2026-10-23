// Tweak and Remix between rounds (R2), as pure functions: the room's requests (chips or free text,
// max 3), the backend request, and the local preset patches the TV applies when the backend
// cannot answer (offline, timeout). The reducer lives in state/machine.ts (TweakInfo).
import type { BlockRegistry } from '@cadabra/engine';
import { TWEAK_CHIPS, TWEAK_CHIP_LABELS, type GameSpec, type TweakChip, type TweakRequest } from '@cadabra/spec';
import { tweakId } from '../fallback/lineage';

/** Phones (and the TV's D-pad) send requests for this long. */
export const TWEAK_ASK_SEC = 10;
/** At most this many requests go to the designer. */
export const MAX_TWEAKS = 3;
/** Once MAX_TWEAKS are in, rebuild after this pause (the third chip gets its moment). */
export const TWEAK_FULL_MS = 1200;
/** No forge.tweaked this long after asking: apply the local presets instead. */
export const TWEAK_TIMEOUT_MS = 15_000;
/** "Rebuilding…" shows at least this long, even for an instant answer. */
export const REBUILD_MIN_MS = 1400;
/** The "What changed" card holds this long before the replay. */
export const CHANGED_HOLD_MS = 3800;

export { TWEAK_CHIPS, TWEAK_CHIP_LABELS, type TweakChip };

export interface TweakAsk { by: string; chip?: TweakChip; text?: string }

/** Free text that obviously means a chip ("make it floaty" -> low-gravity). */
const CHIP_WORDS: [RegExp, TweakChip][] = [
  [/gravity|float|moon|space|zero.?g/i, 'low-gravity'],
  [/fast|speed|quick|turbo/i, 'faster'],
  [/big|huge|large|giant|room|wide/i, 'bigger-arena'],
  [/bounc|boing|rubber|pinball|spring/i, 'bouncier'],
  [/chaos|crazy|wild|mayhem|madness|insane/i, 'more-chaos'],
  [/leader|winner|winning|first place|catch.?up|unfair|comeback/i, 'harder-for-leader'],
];

/** The chip a typed request (or a chip label) maps to, if any. */
export function chipOf(text: string): TweakChip | undefined {
  const t = text.trim().toLowerCase().replace(/[!.?]+$/, '');
  const exact = TWEAK_CHIPS.find((c) => TWEAK_CHIP_LABELS[c].toLowerCase() === t || c === t);
  if (exact) return exact;
  return CHIP_WORDS.find(([re]) => re.test(t))?.[1];
}

const keyOf = (a: TweakAsk) => (a.chip ? `chip:${a.chip}` : `text:${(a.text ?? '').trim().toLowerCase()}`);

/** Add one request: dedupes (same chip or same words), keeps the first MAX_TWEAKS. */
export function addAsk(list: readonly TweakAsk[], a: TweakAsk): TweakAsk[] {
  const text = a.text?.trim().slice(0, 80);
  const ask: TweakAsk = a.chip ? { by: a.by, chip: a.chip } : text ? { by: a.by, text } : { by: a.by };
  if (!ask.chip && !ask.text) return [...list];
  if (list.length >= MAX_TWEAKS || list.some((x) => keyOf(x) === keyOf(ask))) return [...list];
  return [...list, ask];
}

export const askLabel = (a: TweakAsk): string => (a.chip ? TWEAK_CHIP_LABELS[a.chip] : a.text ?? '');

/** The requests as sent in forge.tweak. */
export function toRequests(asks: readonly TweakAsk[]): TweakRequest[] {
  return asks.slice(0, MAX_TWEAKS).map((a) => {
    const playerId = a.by.slice(0, 32);
    return a.chip ? { chip: a.chip, playerId } : { text: (a.text ?? '').slice(0, 80), playerId };
  });
}

// ---------------------------------------------------------------- local presets

export interface TweakResult {
  spec: GameSpec;
  summary: string;
  changes: string[];
  source: 'ai' | 'preset' | 'none';
}

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => !!x && typeof x === 'object' && !Array.isArray(x);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const round = (n: number) => Math.round(n * 1000) / 1000;

/** min/max of a zod number schema (unwrapping optional/default), if any. */
function bounds(schema: unknown): { min?: number; max?: number; int?: boolean } | undefined {
  let s = schema as { _def?: { typeName?: string; innerType?: unknown; checks?: { kind: string; value?: number }[] } } | undefined;
  for (let i = 0; i < 4 && s?._def && s._def.typeName !== 'ZodNumber'; i++) s = s._def.innerType as typeof s;
  if (!s?._def || s._def.typeName !== 'ZodNumber') return undefined;
  const out: { min?: number; max?: number; int?: boolean } = {};
  for (const c of s._def.checks ?? []) {
    if (c.kind === 'min') out.min = c.value;
    if (c.kind === 'max') out.max = c.value;
    if (c.kind === 'int') out.int = true;
  }
  return out;
}

interface Edit { chip: TweakChip; changed: boolean }

/** Block params: scale/set one param on every block that has it, clamped to its schema. */
function editParams(spec: GameSpec, registry: BlockRegistry | undefined, key: string, f: (v: number) => number): boolean {
  let changed = false;
  for (const use of [...spec.blocks, ...spec.modifiers]) {
    const def = registry?.get(use.block);
    const shape = (def?.paramsSchema as { shape?: Rec } | undefined)?.shape;
    if (registry && (!shape || !(key in shape))) continue;
    const defaults = (def?.defaults ?? {}) as Rec;
    const cur = typeof use.params[key] === 'number' ? (use.params[key] as number) : typeof defaults[key] === 'number' ? (defaults[key] as number) : undefined;
    if (cur === undefined) continue;
    let next = f(cur);
    const b = bounds(shape?.[key]);
    if (b?.min !== undefined) next = Math.max(b.min, next);
    if (b?.max !== undefined) next = Math.min(b.max, next);
    next = b?.int ? Math.round(next) : round(next);
    if (next !== cur) { use.params[key] = next; changed = true; }
  }
  return changed;
}

function setBoolParam(spec: GameSpec, registry: BlockRegistry | undefined, key: string, v: boolean): boolean {
  let changed = false;
  for (const use of [...spec.blocks, ...spec.modifiers]) {
    const def = registry?.get(use.block);
    const shape = (def?.paramsSchema as { shape?: Rec } | undefined)?.shape;
    if (!shape || !(key in shape)) continue;
    const cur = use.params[key] ?? (def?.defaults as Rec | undefined)?.[key];
    if (cur !== v) { use.params[key] = v; changed = true; }
  }
  return changed;
}

/** spec.world.physics (engine R2) when the spec has one. Only keys that already exist are edited. */
function physicsOf(spec: GameSpec): Rec | undefined {
  const w = (spec as unknown as Rec).world;
  return isRec(w) && isRec(w.physics) ? w.physics : undefined;
}

function scalePhys(ph: Rec | undefined, re: RegExp, f: (v: number) => number, lo = -Infinity, hi = Infinity): boolean {
  if (!ph) return false;
  let changed = false;
  for (const [k, v] of Object.entries(ph)) {
    if (!re.test(k)) continue;
    const clamp = (n: number) => round(Math.min(hi, Math.max(lo, n)));
    if (typeof v === 'number') {
      const n = clamp(f(v));
      if (n !== v) { ph[k] = n; changed = true; }
    } else if (isRec(v)) {
      for (const [a, x] of Object.entries(v)) {
        if (typeof x !== 'number') continue;
        const n = round(f(x));
        if (n !== x) { v[a] = n; changed = true; }
      }
    }
  }
  return changed;
}

const PRESET_TAG: Record<TweakChip, string> = {
  'low-gravity': 'Gravity ×0.4', faster: 'Speed ×1.3', 'bigger-arena': 'Arena ↑', bouncier: 'Bounce ↑',
  'more-chaos': 'Chaos ↑', 'harder-for-leader': 'Comeback ↑',
};

function applyChip(spec: GameSpec, chip: TweakChip, reg: BlockRegistry | undefined): Edit {
  const ph = physicsOf(spec);
  const any = (...xs: boolean[]) => xs.some(Boolean);
  switch (chip) {
    case 'low-gravity':
      return { chip, changed: any(
        scalePhys(ph, /gravity/i, (v) => v * 0.4),
        scalePhys(ph, /linearDamping|damping/i, (v) => v * 0.5, 0),
        editParams(spec, reg, 'friction', (v) => v * 0.35),
        editParams(spec, reg, 'accel', (v) => v * 0.6),
      ) };
    case 'faster':
      return { chip, changed: any(
        editParams(spec, reg, 'speed', (v) => v * 1.3),
        editParams(spec, reg, 'accel', (v) => v * 1.3),
        editParams(spec, reg, 'dashCooldownSec', (v) => v * 0.75),
        editParams(spec, reg, 'scrollSpeed', (v) => v * 1.3),
      ) };
    case 'bigger-arena':
      return { chip, changed: any(
        editParams(spec, reg, 'ringRadius', (v) => v * 1.2),
        editParams(spec, reg, 'ringShrinkTo', (v) => v * 1.2),
        editParams(spec, reg, 'avatarScale', (v) => v * 0.8),
      ) };
    case 'bouncier':
      return { chip, changed: any(
        scalePhys(ph, /restitution|bounce/i, (v) => Math.max(v + 0.3, v * 1.5), 0, 1),
        setBoolParam(spec, reg, 'bounceWalls', true),
        editParams(spec, reg, 'dashShove', (v) => v * 1.3),
      ) };
    case 'more-chaos':
      return { chip, changed: any(
        scalePhys(ph, /knockback/i, (v) => v * 1.5, 0, 4),
        editParams(spec, reg, 'dashShove', (v) => v * 1.5),
        editParams(spec, reg, 'dashCooldownSec', (v) => v * 0.6),
        editParams(spec, reg, 'shoveStunSec', (v) => v * 1.5),
      ) };
    case 'harder-for-leader': {
      const before = JSON.stringify(spec.comeback);
      spec.comeback = { enabled: true, strength: round(Math.min(1, Math.max(0.6, spec.comeback.strength + 0.3))) };
      return { chip, changed: JSON.stringify(spec.comeback) !== before };
    }
  }
}

/**
 * The local preset patch: every chip the requests name (typed text included, via chipOf),
 * applied in order. Nothing applicable: the same spec, source 'none'.
 */
export function presetTweak(base: GameSpec, asks: readonly TweakAsk[], registry?: BlockRegistry, now = Date.now()): TweakResult {
  const chips: TweakChip[] = [];
  for (const a of asks) {
    const c = a.chip ?? (a.text ? chipOf(a.text) : undefined);
    if (c && !chips.includes(c)) chips.push(c);
  }
  const spec = clone(base);
  const tags = chips.map((c) => applyChip(spec, c, registry)).filter((e) => e.changed).map((e) => PRESET_TAG[e.chip]);
  if (tags.length === 0) return { spec: base, summary: 'Same rules, round two!', changes: [], source: 'none' };
  spec.id = tweakId(base, now);
  spec.origin = { ...base.origin, parentId: base.id };
  spec.title = remixTitle(base.title);
  return { spec, summary: tags.join(' · '), changes: tags, source: 'preset' };
}

/** "RING OUT" -> "RING OUT REMIX" (once, within the 40-char title cap). */
export function remixTitle(t: string): string {
  if (/remix$/i.test(t)) return t;
  const suffix = t === t.toUpperCase() ? ' REMIX' : ' Remix';
  return (t + suffix).length <= 40 ? t + suffix : t;
}
