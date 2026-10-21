import type { InputFrame } from '@cadabra/spec';
import type { BlockCtx } from '../block';
import type { Entity } from '../world';

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

/** Stun contract shared by all blocks: props.stunUntil holds sim time in seconds. */
export function isStunned(ctx: BlockCtx<unknown>, e: Entity): boolean {
  const s = e.props.stunUntil;
  return typeof s === 'number' && ctx.time < s;
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
    const opts = { owner: p.id, r, sprite: `avatar:${p.id}`, props: { mover: blockId, boost: 1 } as Entity['props'] };
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

/**
 * Simple movement for avatars a block spawned itself (no arena-move in the spec):
 * velocity = intent * speed * boost, clamped to the arena after integration.
 */
export function fallbackMove(ctx: BlockCtx<unknown>, blockId: string, intents: Map<string, Vec>, dt: number): void {
  const { width: w, height: h } = ctx.world;
  for (const p of ctx.players) {
    const e = ctx.entityOf(p.id);
    if (!e || e.props.mover !== blockId) continue;
    const d = intents.get(p.id);
    const s = isStunned(ctx, e) || !d ? 0 : FALLBACK_SPEED * boostOf(e);
    e.vx = (d?.x ?? 0) * s;
    e.vy = (d?.y ?? 0) * s;
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
