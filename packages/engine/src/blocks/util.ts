import type { InputFrame } from '@cadabra/spec';
import type { BlockCtx } from '../block';
import type { Entity } from '../world';

/**
 * Cross-block entity props (the composition contract):
 * - `mover`: id of the block that moves this avatar (arena-move claims all; collect/dodge
 *   move only avatars they spawned themselves; race claims its runners).
 * - `topSpeed` / `accel`: the mover's current movement limits (px/s, px/s²), so hazard
 *   blocks can size telegraphs and gaps to what an avatar can actually escape.
 * - `dashKey`: controller button the mover dashes on ('' = none), so other blocks' bots
 *   can veto or use dashing.
 * - `stunUntil`: sim seconds; movers ignore input until then.
 * - `rammedBy` / `rammedAt`: last ram on this avatar, recorded by the mover before it
 *   exchanges velocities (see markRam / rammer).
 * - `invulnUntil`: sim seconds; hazards can't hurt the avatar until then.
 * - `speedMul`: per-step top-speed multiplier set by a non-mover block (sneak's tiptoe);
 *   movers multiply their top speed by it. Absent = 1.
 * - `loadMul`: top-speed multiplier from what the avatar carries (collect); multiplies with
 *   speedMul. Absent = 1.
 * - `noiseMul`: how much louder than normal the avatar is (collect: carried loot); sneak's
 *   guards hear noise × noiseMul. Absent = 1.
 * - `carry`: number of items the avatar carries (collect), for renderers and other bots.
 * - `loud`: 0..1 how loud the avatar is right now (sneak), for renderers.
 * - `fumbleAt`: sim seconds; any block sets it to make the avatar drop everything it carries
 *   (sneak's chasing guard on a catch). Carrying blocks honour each new value once.
 * - `shovedBy` / `shovedAt`: last hard shove (dash bump) on this avatar, recorded by the
 *   mover; hazard blocks credit knockouts to the shover.
 * - Floor tiles: entities of kind 'tile' (dodge's crumbling floor). When any exist, a point
 *   is only on solid floor if a tile covers it (see onFloor); `props.crumbling` tiles are
 *   about to drop.
 */

/** Base avatar radius in px at avatarScale 1. */
export const AVATAR_R = 22;
/** Speed used by a block that had to spawn (and so must move) its own avatars. */
export const FALLBACK_SPEED = 260;
const DEADZONE = 0.08;

export interface Vec {
  x: number;
  y: number;
}

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

export function len(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Scale (x, y) down to at most unit length; tiny inputs inside the deadzone become zero. */
export function unit(x: number, y: number, out: Vec = { x: 0, y: 0 }): Vec {
  const l = len(x, y);
  if (l < DEADZONE) {
    out.x = 0;
    out.y = 0;
  } else if (l > 1) {
    out.x = x / l;
    out.y = y / l;
  } else {
    out.x = x;
    out.y = y;
  }
  return out;
}

/**
 * Movement intent from a frame. `mode` picks the primary source; the other is a
 * fallback, so bots (which send axes) and misconfigured controllers still move.
 */
export function inputDir(input: InputFrame, mode: 'joystick' | 'tilt', tiltGain = 1, out: Vec = { x: 0, y: 0 }): Vec {
  const tilt = input.tilt ? { x: input.tilt.x * tiltGain, y: input.tilt.y * tiltGain } : undefined;
  const src = mode === 'tilt' ? (tilt ?? input.axes) : (input.axes ?? tilt);
  return src ? unit(src.x, src.y, out) : unit(0, 0, out);
}

/** Per-ctx state for a block (the BlockDef object is shared; the ctx is per instance). */
export function stateOf<S>(map: WeakMap<object, S>, ctx: object, init: () => S): S {
  let s = map.get(ctx);
  if (!s) {
    s = init();
    map.set(ctx, s);
  }
  return s;
}

/** Rising edge of a held button: true only on the frame it goes down. */
export function pressed(prev: Map<string, boolean>, key: string, down: boolean): boolean {
  const was = prev.get(key) ?? false;
  prev.set(key, down);
  return down && !was;
}

export function boostOf(e: Entity): number {
  const b = e.props.boost;
  return typeof b === 'number' ? b : 1;
}

/** Top-speed multiplier another block requests for this avatar (e.g. tiptoe). */
export function speedMulOf(e: Entity): number {
  const m = e.props.speedMul, l = e.props.loadMul;
  return (typeof m === 'number' ? m : 1) * (typeof l === 'number' ? l : 1);
}

/** Popup label from a sprite key: 'golden_fish' -> 'Golden fish'. */
export function labelOf(key: string): string {
  const t = key.replace(/[_-]+/g, ' ').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : 'Item';
}

/**
 * Headline moment for the TV to call out: emits `<ns>.<moment>` with data.moment = moment,
 * so the TV can match on the moment whatever namespace a spec picked. '' ns = off.
 */
export function callout(ctx: BlockCtx<unknown>, ns: string, moment: string, player?: string, data: Record<string, unknown> = {}): void {
  if (!ns) return;
  const e: { type: string; player?: string; data: Record<string, unknown> } = { type: `${ns}.${moment}`, data: { ...data, moment } };
  if (player !== undefined) e.player = player;
  ctx.emit(e);
}

/** Half-extents of a floor tile entity (props.hw / props.hh, else its radius). */
function tileHalf(t: Entity): Vec {
  const hw = typeof t.props.hw === 'number' ? t.props.hw : t.r;
  const hh = typeof t.props.hh === 'number' ? t.props.hh : t.r;
  return { x: hw, y: hh };
}

/**
 * Is (x, y) on solid floor? True when the world has no floor tiles at all; otherwise a tile
 * must cover the point (and, with `stable`, must not be crumbling).
 */
export function onFloor(ctx: BlockCtx<unknown>, x: number, y: number, stable = false): boolean {
  let any = false;
  for (const t of ctx.world.byKind('tile')) {
    any = true;
    const h = tileHalf(t);
    if (Math.abs(x - t.x) <= h.x && Math.abs(y - t.y) <= h.y) return !(stable && t.props.crumbling === true);
  }
  return !any;
}

/** Stun contract shared by all blocks: props.stunUntil holds sim time in seconds. */
export function isStunned(ctx: BlockCtx<unknown>, e: Entity): boolean {
  const s = e.props.stunUntil;
  return typeof s === 'number' && ctx.time < s;
}

/** Movement limits of the slowest / largest live avatar (used for fairness maths). */
export interface MoveCaps {
  speed: number;
  accel: number;
  r: number;
}

/** Instant-acceleration stand-in for movers that set velocity directly. */
export const INSTANT_ACCEL = 1e6;
/** Human reaction allowance added to every escape-time calculation. */
export const REACTION_SEC = 0.25;

export function moveCaps(ctx: BlockCtx<unknown>): MoveCaps {
  let speed = Infinity, accel = Infinity, r = 0;
  for (const p of ctx.players) {
    const e = ctx.entityOf(p.id);
    if (!e) continue;
    const s = typeof e.props.topSpeed === 'number' ? e.props.topSpeed : FALLBACK_SPEED;
    const a = typeof e.props.accel === 'number' ? e.props.accel : INSTANT_ACCEL;
    if (s < speed) speed = s;
    if (a < accel) accel = a;
    if (e.r > r) r = e.r;
  }
  if (speed === Infinity) return { speed: FALLBACK_SPEED, accel: INSTANT_ACCEL, r: AVATAR_R };
  return { speed, accel, r };
}

/** Seconds an avatar with `caps` needs to move `dist` px from a standstill, plus reaction. */
export function escapeTime(dist: number, caps: MoveCaps): number {
  if (dist <= 0) return REACTION_SEC;
  return REACTION_SEC + caps.speed / (2 * caps.accel) + dist / caps.speed;
}

/**
 * Spawn an avatar for every player that has none yet (block used without arena-move).
 * Avatars this call spawns are claimed with props.mover = blockId so that block moves
 * them; arena-move overrides the claim on any avatar regardless of setup order.
 */
export function ensureAvatars(ctx: BlockCtx<unknown>, blockId: string, r = AVATAR_R): void {
  const { width: w, height: h } = ctx.world;
  const n = ctx.players.length;
  const ring = Math.min(w, h) * 0.3;
  ctx.players.forEach((p, i) => {
    if (ctx.entityOf(p.id)) return;
    const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
    const props: Entity['props'] = { mover: blockId, boost: 1, topSpeed: FALLBACK_SPEED, accel: INSTANT_ACCEL };
    const opts = { owner: p.id, r, sprite: `avatar:${p.id}`, props };
    if (p.team !== undefined) Object.assign(opts, { team: p.team });
    ctx.world.spawn('player', w / 2 + Math.cos(a) * ring, h / 2 + Math.sin(a) * ring, opts);
  });
}

/**
 * Ram contract: a mover that resolves avatar collisions records who hit whom (before
 * velocities are exchanged) so other blocks (collect's steal) can attribute the bump.
 */
export function markRam(attacker: Entity, victim: Entity, t: number): void {
  if (attacker.owner === undefined) return;
  victim.props.rammedBy = attacker.owner;
  victim.props.rammedAt = t;
}

/** Mark a ram as used so one bump is acted on once. */
export function consumeRam(e: Entity): void {
  delete e.props.rammedBy;
  delete e.props.rammedAt;
}

/** Who is ramming whom between two touching avatars, or undefined if neither is. */
export function rammer(a: Entity, b: Entity, t: number, minSpeed = 60): Entity | undefined {
  const recent = (v: Entity, by: Entity) =>
    v.props.rammedBy === by.owner && typeof v.props.rammedAt === 'number' && t - v.props.rammedAt <= 0.1;
  if (recent(b, a)) return a;
  if (recent(a, b)) return b;
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = len(dx, dy) || 1;
  const aIn = (a.vx * dx + a.vy * dy) / d, bIn = -(b.vx * dx + b.vy * dy) / d;
  if (Math.max(aIn, bIn) < minSpeed) return undefined;
  return aIn >= bIn ? a : b;
}

/** Keep a circle inside the arena; bounce reflects velocity, otherwise it is zeroed. */
export function keepInArena(e: Entity, w: number, h: number, bounce: number): boolean {
  let hit = false;
  if (e.x < e.r) { e.x = e.r; if (e.vx < 0) e.vx = -e.vx * bounce; hit = true; }
  if (e.x > w - e.r) { e.x = w - e.r; if (e.vx > 0) e.vx = -e.vx * bounce; hit = true; }
  if (e.y < e.r) { e.y = e.r; if (e.vy < 0) e.vy = -e.vy * bounce; hit = true; }
  if (e.y > h - e.r) { e.y = h - e.r; if (e.vy > 0) e.vy = -e.vy * bounce; hit = true; }
  return hit;
}

/** Velocity decay per second of a stunned (tumbling) avatar under fallbackMove. */
const TUMBLE_FRICTION = 5;

/**
 * Simple movement for avatars a block spawned itself (no arena-move in the spec):
 * velocity = intent * speed * boost, clamped to the arena after integration.
 */
export function fallbackMove(ctx: BlockCtx<unknown>, blockId: string, intents: Map<string, Vec>, dt: number): void {
  const { width: w, height: h } = ctx.world;
  for (const p of ctx.players) {
    const e = ctx.entityOf(p.id);
    if (!e || e.props.mover !== blockId) continue;
    e.props.topSpeed = FALLBACK_SPEED;
    e.props.accel = INSTANT_ACCEL;
    const d = intents.get(p.id);
    if (isStunned(ctx, e)) {
      // a stunned avatar tumbles: knockback slides out instead of stopping dead
      const k = Math.exp(-TUMBLE_FRICTION * dt);
      e.vx *= k;
      e.vy *= k;
    } else {
      const s = !d ? 0 : FALLBACK_SPEED * boostOf(e) * speedMulOf(e);
      e.vx = (d?.x ?? 0) * s;
      e.vy = (d?.y ?? 0) * s;
    }
    // pre-clamp the coming integration so the avatar never leaves the arena
    const nx = e.x + e.vx * dt, ny = e.y + e.vy * dt;
    if (nx < e.r || nx > w - e.r) e.vx = 0;
    if (ny < e.r || ny > h - e.r) e.vy = 0;
    keepInArena(e, w, h, 0);
  }
}

/** Per-bot memory shared by the steering helper. */
export interface BotMem {
  wobble: number;
  targetId?: number;
  until: number;
  tx: number;
  ty: number;
}

export function botMem(map: Map<string, BotMem>, id: string): BotMem {
  let m = map.get(id);
  if (!m) {
    m = { wobble: 0, until: 0, tx: 0, ty: 0 };
    map.set(id, m);
  }
  return m;
}

/**
 * Plausible bot aim: heads for (tx, ty) with a slowly drifting angular error that grows
 * as skill drops, and eases off near the target. Uses ctx.rng only (deterministic).
 */
export function steer(ctx: BlockCtx<unknown>, mem: BotMem, from: Vec, tx: number, ty: number, skill: number): Vec {
  const sloppiness = 1 - clamp(skill, 0, 1);
  mem.wobble = clamp(mem.wobble + ctx.rng.range(-1, 1) * sloppiness * 0.25, -sloppiness * 0.9, sloppiness * 0.9);
  const dx = tx - from.x, dy = ty - from.y;
  const d = len(dx, dy);
  if (d < 4) return { x: 0, y: 0 };
  const a = Math.atan2(dy, dx) + mem.wobble;
  const m = Math.min(1, d / 40);
  return { x: Math.cos(a) * m, y: Math.sin(a) * m };
}
