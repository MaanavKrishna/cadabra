/**
 * Competitive arena modes layered on arena-move (all opt-in params, off by default):
 * - RING OUT (`ringOut`): a round floating platform of floor tiles that crumbles inward ring
 *   by ring; leaving it is a ring-out (+points to whoever touched you last), respawn in the
 *   centre with a short invulnerability.
 * - OVERLOAD (`overload`): hot potato. One player holds an unstable core; touching a rival
 *   passes it; when its hidden 7–13 s fuse runs out the holder loses points and everyone
 *   else scores.
 * - PAINT (`paint`): the floor is a tile grid; moving paints tiles in your team colour (or
 *   your own colour in free-for-all); dashing paints a burst; territory share scores on a
 *   timer and the final tally counts extra.
 */
import type { InputFrame } from '@cadabra/spec';
import type { BlockCtx } from '../block';
import type { Entity } from '../world';
import type { ArenaMoveParams } from './arena-move';
import { type BotMem, botMem, callout, clamp, isStunned, len, onFloor, steer } from './util';

type Ctx = BlockCtx<ArenaMoveParams>;
const U = (ctx: Ctx) => ctx as unknown as BlockCtx<unknown>;

/** What a mode bot needs to know about arena-move's per-player dash state. */
export interface DashInfo {
  ready: boolean;
  face: { x: number; y: number };
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d);

/** A penalty that never takes a score below zero (small games stay winnable for everyone). */
function penalize(ctx: Ctx, id: string, n: number, reason: string): void {
  const have = ctx.players.find((p) => p.id === id)?.score ?? 0;
  const d = Math.min(n, Math.max(0, have));
  if (d > 0) ctx.score(id, -d, reason);
}
const invuln = (ctx: Ctx, e: Entity) => ctx.time < num(e.props.invulnUntil);
/** Avatar is out of play (fell off the ring, waiting to respawn). */
export const isOut = (e: Entity): boolean => e.props.out === true;

// ---------------------------------------------------------------- RING OUT

/** Seconds a ring shakes before it drops. */
export const RING_WARN_SEC = 1.5;

export interface RingState {
  cx: number;
  cy: number;
  radius: number;
  tile: number;
  /** Rings that will drop this round, outermost (0) first. */
  dropTimes: number[];
  nextDrop: number;
  warned: number;
  respawnAt: Map<string, number>;
  bots: Map<string, BotMem>;
}

export function ringSetup(ctx: Ctx): RingState {
  const P = ctx.params;
  const { width: w, height: h } = ctx.world;
  const cx = w / 2, cy = h / 2;
  const radius = Math.min(P.ringRadius, Math.min(w, h) / 2 - 8);
  const tile = P.ringTile;
  const n = Math.ceil(radius / tile);
  let maxRing = 0;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const x = cx + i * tile, y = cy + j * tile;
      const d = len(x - cx, y - cy);
      if (d > radius - tile * 0.3) continue;
      const ring = Math.max(0, Math.floor((radius - d) / tile));
      if (ring > maxRing) maxRing = ring;
      ctx.world.spawn('tile', x, y, {
        sprite: 'tile', r: tile * 0.71,
        props: { hw: tile / 2, hh: tile / 2, ring, col: i + n, row: j + n, crumbling: false, fallAt: 0 },
      });
    }
  }
  // rings to drop: down to ringShrinkTo, always keeping the inner core
  const k = clamp(Math.floor((radius - P.ringShrinkTo) / tile), 0, Math.max(0, maxRing - 1));
  const D = ctx.spec.durationSec;
  const start = D * 0.3, end = Math.max(start, D - 6);
  const dropTimes = Array.from({ length: k }, (_, i) => (k === 1 ? start : start + ((end - start) * i) / (k - 1)));
  // everyone starts on a circle around the centre, facing in
  const np = ctx.players.length;
  ctx.players.forEach((p, i) => {
    const e = ctx.entityOf(p.id);
    if (!e) return;
    const a = (i / Math.max(1, np)) * Math.PI * 2 - Math.PI / 2;
    e.x = cx + Math.cos(a) * radius * 0.5;
    e.y = cy + Math.sin(a) * radius * 0.5;
    e.vx = e.vy = 0;
    e.props.out = false;
  });
  return { cx, cy, radius, tile, dropTimes, nextDrop: 0, warned: 0, respawnAt: new Map(), bots: new Map() };
}

/** Radius of solid floor that is not about to drop. */
export function ringSafeRadius(r: RingState): number {
  return r.radius - r.tile * r.warned;
}

function crumbleRing(ctx: Ctx, r: RingState, ring: number, phase: 'warn' | 'fall'): void {
  const fallAt = ctx.time + RING_WARN_SEC;
  if (phase === 'warn') {
    for (const t of ctx.world.ofKind('tile')) if (t.props.ring === ring) { t.props.crumbling = true; t.props.fallAt = fallAt; }
  } else {
    const drop: number[] = [];
    for (const t of ctx.world.ofKind('tile')) if (num(t.props.ring) <= ring) drop.push(t.id);
    for (const id of drop) ctx.world.remove(id);
    // everyone still standing when a ring drops scores
    if (ctx.params.ringSurvivePoints > 0) {
      for (const p of ctx.players) {
        const e = ctx.entityOf(p.id);
        if (e && !isOut(e)) ctx.score(p.id, ctx.params.ringSurvivePoints, 'SURVIVED');
      }
    }
    ctx.fx({ kind: 'shake', strength: 0.3 });
    ctx.fx({ kind: 'sfx', name: 'hit' });
  }
  callout(U(ctx), ctx.params.callout, 'crumble', undefined, phase === 'warn' ? { ring, phase, warnSec: RING_WARN_SEC } : { ring, phase });
}

/** Drop the next ring early (timeline hook): warn now, fall after RING_WARN_SEC. */
export function ringCrumbleNow(ctx: Ctx, r: RingState): void {
  if (r.warned >= r.dropTimes.length) return;
  r.dropTimes[r.warned] = Math.min(r.dropTimes[r.warned]!, ctx.time + RING_WARN_SEC);
}

export function ringUpdate(ctx: Ctx, r: RingState): void {
  const P = ctx.params;
  const t = ctx.time;
  // crumble schedule: warn RING_WARN_SEC before each drop
  while (r.warned < r.dropTimes.length && t >= r.dropTimes[r.warned]! - RING_WARN_SEC) crumbleRing(ctx, r, r.warned++, 'warn');
  while (r.nextDrop < r.warned && t >= r.dropTimes[r.nextDrop]!) crumbleRing(ctx, r, r.nextDrop++, 'fall');

  for (const p of ctx.players) {
    const e = ctx.entityOf(p.id);
    if (!e) continue;
    if (isOut(e)) {
      if (t < (r.respawnAt.get(p.id) ?? 0)) { e.vx = e.vy = 0; continue; }
      respawn(ctx, r, e);
      ctx.emit({ type: 'arena.respawn', player: p.id });
      // comeback: the player in last place bounces back with a point
      if (P.ringComebackPoints > 0 && ctx.players.every((q) => q.score >= p.score) && ctx.players.some((q) => q.score > p.score)) {
        ctx.score(p.id, P.ringComebackPoints, 'BOUNCE BACK');
      }
      continue;
    }
    if (invuln(ctx, e) || onFloor(U(ctx), e.x, e.y)) continue;
    // fell off the ring
    e.props.out = true;
    e.props.outAt = t;
    e.props.dashing = false;
    e.vx = e.vy = 0;
    r.respawnAt.set(p.id, t + P.respawnSec);
    const by = typeof e.props.touchedBy === 'string' ? e.props.touchedBy : '';
    const fresh = by !== '' && by !== p.id && t - num(e.props.touchedAt, -99) <= P.ringCreditSec;
    if (P.ringFallPenalty > 0) penalize(ctx, p.id, P.ringFallPenalty, 'FELL!');
    ctx.emit({ type: 'arena.fall', player: p.id, data: { by: fresh ? by : null } });
    if (fresh) {
      ctx.score(by, P.ringOutPoints, 'RING OUT!');
      callout(U(ctx), P.callout, 'ringout', by, { victim: p.id });
      ctx.fx({ kind: 'flash', color: '#FF2BD6' });
    }
    ctx.fx({ kind: 'particles', preset: 'burst', x: e.x, y: e.y });
    ctx.fx({ kind: 'sfx', name: 'fall' });
    delete e.props.touchedBy;
    delete e.props.touchedAt;
  }
}

function respawn(ctx: Ctx, r: RingState, e: Entity): void {
  // the centre, nudged off anyone standing there
  let x = r.cx, y = r.cy;
  for (let k = 0; k < 8; k++) {
    const busy = ctx.players.some((p) => {
      const o = ctx.entityOf(p.id);
      return o && o !== e && !isOut(o) && len(o.x - x, o.y - y) < o.r + e.r + 4;
    });
    if (!busy) break;
    const a = (k / 8) * Math.PI * 2;
    x = r.cx + Math.cos(a) * e.r * 2.2;
    y = r.cy + Math.sin(a) * e.r * 2.2;
  }
  e.x = x;
  e.y = y;
  e.vx = e.vy = 0;
  e.props.out = false;
  e.props.invulnUntil = ctx.time + ctx.params.respawnInvulnSec;
  e.props.stunUntil = 0;
  delete e.props.touchedBy;
  delete e.props.touchedAt;
  ctx.fx({ kind: 'particles', preset: 'sparkle', x, y });
}

export function ringBot(ctx: Ctx, r: RingState, id: string, skill: number, dash: DashInfo, key: string): InputFrame {
  const e = ctx.entityOf(id);
  if (!e || isOut(e)) return { t: 0, axes: { x: 0, y: 0 } };
  const m = botMem(r.bots, id);
  // skill shows in reading dashes, picking targets and committing; movement itself is shared
  const SK = clamp(skill, 0, 1);
  const sk = 0.7;
  const safe = ringSafeRadius(r);
  const d = len(e.x - r.cx, e.y - r.cy);
  const frame = (axes: { x: number; y: number }, press = false): InputFrame => {
    const f: InputFrame = { t: 0, axes };
    if (key) f.buttons = { [key]: press };
    return f;
  };
  // too close to the edge (or sliding toward it fast): get back to the middle
  const outward = d > 1 ? (e.vx * (e.x - r.cx) + e.vy * (e.y - r.cy)) / d : 0;
  const margin = e.r + 30 + Math.max(0, outward) * 0.4;
  if (d > safe - margin && (d > safe - e.r || ctx.rng.next() < 0.8)) return frame(steer(U(ctx), m, e, r.cx, r.cy, 0.6 + 0.4 * sk));

  // dodge a rival dashing at me (better bots see it coming)
  for (const p of ctx.players) {
    const o = p.id === id ? undefined : ctx.entityOf(p.id);
    if (!o || isOut(o) || o.props.dashing !== true) continue;
    const dx = e.x - o.x, dy = e.y - o.y, dd = len(dx, dy);
    if (dd > 200 || dd < 1) continue;
    const toward = (o.vx * dx + o.vy * dy) / (dd * (len(o.vx, o.vy) || 1));
    if (toward > 0.8 && ctx.rng.next() < 0.1 + 0.4 * SK) {
      // sidestep toward the centre-ish side
      let sx = -dy / dd, sy = dx / dd;
      if (sx * (r.cx - e.x) + sy * (r.cy - e.y) < 0) { sx = -sx; sy = -sy; }
      return frame({ x: sx, y: sy });
    }
  }

  // hunt: the rival nearest the edge that I can get behind
  if (ctx.time >= m.until || m.targetId === undefined) {
    let best = Infinity;
    m.targetId = undefined;
    for (const p of ctx.players) {
      const o = p.id === id ? undefined : ctx.entityOf(p.id);
      if (!o || isOut(o) || invuln(ctx, o)) continue;
      const c = len(o.x - e.x, o.y - e.y) - 0.9 * len(o.x - r.cx, o.y - r.cy) + ctx.rng.range(0, 120) * (1 - SK);
      if (c < best) { best = c; m.targetId = o.id; }
    }
    m.until = ctx.time + ctx.rng.range(0.6, 1.4);
  }
  const o = m.targetId !== undefined ? ctx.world.get(m.targetId) : undefined;
  if (!o || isOut(o) || invuln(ctx, o)) {
    m.targetId = undefined;
    return frame(steer(U(ctx), m, e, r.cx, r.cy, sk));
  }
  const od = len(o.x - r.cx, o.y - r.cy) || 1;
  const ux = (o.x - r.cx) / od, uy = (o.y - r.cy) / od;
  const tx = o.x - e.x, ty = o.y - e.y, td = len(tx, ty) || 1;
  const aligned = (tx * ux + ty * uy) / td;
  if (aligned > 0.55 && td < 190) {
    // lined up between the rival and the centre: charge
    const lead = 0.1 + 0.2 * sk;
    const axes = steer(U(ctx), m, e, o.x + o.vx * lead, o.y + o.vy * lead, 0.5 + 0.5 * sk);
    const facing = (dash.face.x * tx + dash.face.y * ty) / td;
    // a miss carries you on toward the edge: only commit when close, with room behind the rival
    const room = safe - d;
    const press = dash.ready && facing > 0.75 && td < 120 && room > 130 && ctx.rng.next() < 0.1 + 0.2 * SK;
    return frame(axes, press);
  }
  // circle round to the centre side of the rival
  const back = e.r + o.r + 50;
  let bx = o.x - ux * back, by = o.y - uy * back;
  const bd = len(bx - r.cx, by - r.cy);
  if (bd > safe - e.r - 40) { const k = (safe - e.r - 40) / bd; bx = r.cx + (bx - r.cx) * k; by = r.cy + (by - r.cy) * k; }
  return frame(steer(U(ctx), m, e, bx, by, sk));
}

// ---------------------------------------------------------------- OVERLOAD

/** Seconds of fuse left when the core goes critical (fast pulsing + event). */
export const CRITICAL_SEC = 3;
/** Gap between a detonation (or the round start) and the next core. */
export const RESPAWN_CORE_SEC = 1.5;
const OVERLOAD_BLAST = 160;
/** How often players without a core earn overloadSafePoints. */
export const SAFE_EVERY_SEC = 5;

export interface Core {
  coreId?: number;
  holder: string;
  /** Who handed the core to the current holder ('' = it spawned there). */
  passer: string;
  fuseLen: number;
  fuseAt: number;
  critical: boolean;
  nextSpawnAt: number;
  /** Physics: a passed core flies from the passer to its new holder (sim s start, from x/y). */
  fly?: { t0: number; x: number; y: number };
}

/** Physics: seconds a passed core is airborne, and the knock its catch gives the receiver (px/s). */
export const CORE_FLY_SEC = 0.22;
const CORE_CATCH_KNOCK = 300;

export interface OverloadState {
  cores: Core[];
  nextSafeAt: number;
  /** Passer immunity: can't take a core back until. */
  immuneUntil: Map<string, number>;
  bots: Map<string, BotMem>;
}

export function overloadSetup(ctx: Ctx): OverloadState {
  // one core per two players (2–3 players: 1, 4: 2), capped by overloadCores
  const n = clamp(Math.min(ctx.params.overloadCores, Math.floor(ctx.players.length / 2)), 1, 3);
  const cores = Array.from({ length: n }, (_, i): Core => ({
    holder: '', passer: '', fuseLen: 0, fuseAt: 0, critical: false, nextSpawnAt: RESPAWN_CORE_SEC + i * 2.5,
  }));
  return { cores, nextSafeAt: SAFE_EVERY_SEC, immuneUntil: new Map(), bots: new Map() };
}

const canHold = (ctx: Ctx, e: Entity | undefined): e is Entity => !!e && !isOut(e) && !isStunned(U(ctx), e);
const holding = (o: OverloadState, id: string) => o.cores.some((c) => c.holder === id);

function giveCore(ctx: Ctx, c: Core, id: string): void {
  const P = ctx.params;
  const e = ctx.entityOf(id)!;
  c.holder = id;
  c.passer = '';
  c.fuseLen = ctx.rng.range(P.overloadFuseMin, Math.max(P.overloadFuseMin, P.overloadFuseMax));
  c.fuseAt = ctx.time + c.fuseLen;
  c.critical = false;
  const core = ctx.world.spawn('core', e.x, e.y, { sprite: 'core-unstable', r: 16, props: { holder: id, fuse: 0, fuseLeft: c.fuseLen, critical: false, pulseHz: 1 } });
  c.coreId = core.id;
  ctx.emit({ type: 'arena.core', player: id, data: { fuseSec: Math.round(c.fuseLen * 10) / 10 } });
  callout(U(ctx), P.callout, 'core.spawn', id);
  ctx.fx({ kind: 'sfx', name: 'wake' });
}

/** Timeline hook: every fuse burns down to a few seconds now. */
export function overloadCut(ctx: Ctx, o: OverloadState): void {
  for (const c of o.cores) if (c.holder) c.fuseAt = Math.min(c.fuseAt, ctx.time + CRITICAL_SEC + 0.5);
}

export function overloadUpdate(ctx: Ctx, o: OverloadState): void {
  for (const c of o.cores) coreUpdate(ctx, o, c);
  if (ctx.time >= o.nextSafeAt) {
    o.nextSafeAt += SAFE_EVERY_SEC;
    const n = ctx.params.overloadSafePoints;
    if (n > 0 && o.cores.some((c) => c.holder)) {
      for (const p of ctx.players) if (ctx.entityOf(p.id) && !holding(o, p.id)) ctx.score(p.id, n, 'CLEAN');
    }
  }
}

function coreUpdate(ctx: Ctx, o: OverloadState, c: Core): void {
  const P = ctx.params;
  const t = ctx.time;
  if (!c.holder) {
    if (t < c.nextSpawnAt || ctx.remaining < 3) return;
    const pool = ctx.players.filter((p) => !holding(o, p.id) && canHold(ctx, ctx.entityOf(p.id)));
    if (pool.length < 1 || ctx.players.length < 2) return;
    giveCore(ctx, c, ctx.rng.pick(pool).id);
    return;
  }
  const h = ctx.entityOf(c.holder);
  const core = c.coreId !== undefined ? ctx.world.get(c.coreId) : undefined;
  if (!h || !core) { c.holder = ''; c.nextSpawnAt = t + RESPAWN_CORE_SEC; if (core) ctx.world.remove(core.id); return; }

  // pass on touch (the holder must be able to act; the receiver must be free and not immune)
  if (!isStunned(U(ctx), h) && !isOut(h)) {
    for (const p of ctx.players) {
      if (p.id === c.holder || (o.immuneUntil.get(p.id) ?? 0) > t || holding(o, p.id)) continue;
      const e = ctx.entityOf(p.id);
      if (!canHold(ctx, e) || len(e.x - h.x, e.y - h.y) > e.r + h.r + 6) continue;
      const from = c.holder;
      o.immuneUntil.set(from, t + P.overloadPassImmunitySec);
      c.holder = p.id;
      c.passer = from;
      core.props.holder = p.id;
      const clutch = c.critical && P.overloadClutchPoints > 0;
      if (clutch) ctx.score(from, P.overloadClutchPoints, 'CLUTCH PASS!');
      ctx.emit({ type: 'arena.pass', player: from, data: { to: p.id, clutch } });
      callout(U(ctx), P.callout, 'core.pass', from, { to: p.id, clutch });
      ctx.fx({ kind: 'particles', preset: 'sparkle', x: e.x, y: e.y });
      ctx.fx({ kind: 'sfx', name: 'pass' });
      if (ctx.physics) {
        // physics: the core is flung across and its catch knocks the receiver back
        c.fly = { t0: t, x: core.x, y: core.y };
        const dx = e.x - h.x, dy = e.y - h.y, d = len(dx, dy) || 1;
        const k = CORE_CATCH_KNOCK * ctx.physics.params.knockback;
        e.vx += (dx / d) * k; e.vy += (dy / d) * k;
        e.props.hitAt = t; e.props.impulse = 0.8;
        if (ctx.physics.params.spin) e.props.av = num(e.props.av) + (dx * dy >= 0 ? 8 : -8);
      }
      break;
    }
  }
  const holder = ctx.entityOf(c.holder)!;
  const tx = holder.x, ty = holder.y - holder.r * 0.2;
  const f = c.fly ? (t - c.fly.t0) / CORE_FLY_SEC : 1;
  if (c.fly && f < 1) {
    // airborne: ease from the throw point to the catcher, with a little hop
    const k = f * f * (3 - 2 * f);
    core.x = c.fly.x + (tx - c.fly.x) * k;
    core.y = c.fly.y + (ty - c.fly.y) * k - Math.sin(Math.PI * f) * 40;
    core.props.flying = true;
    core.props.angle = num(core.props.angle) + 0.5;
  } else {
    c.fly = undefined;
    core.x = tx;
    core.y = ty;
    core.props.flying = false;
  }
  core.vx = core.vy = 0;
  const left = Math.max(0, c.fuseAt - t);
  const frac = clamp(1 - left / c.fuseLen, 0, 1);
  core.props.fuse = frac;
  core.props.fuseLeft = left;
  core.props.pulseHz = 1 + 7 * frac * frac;
  if (!c.critical && left <= CRITICAL_SEC) {
    c.critical = true;
    core.props.critical = true;
    callout(U(ctx), P.callout, 'core.critical', c.holder, { fuseLeft: Math.round(left * 10) / 10 });
  }
  if (left > 0) return;

  // detonation
  const victim = c.holder;
  penalize(ctx, victim, P.overloadPenalty, 'OVERLOAD!');
  for (const p of ctx.players) {
    if (p.id === victim || !ctx.entityOf(p.id)) continue;
    const assist = p.id === c.passer ? P.overloadAssistPoints : 0;
    ctx.score(p.id, P.overloadReward + assist, assist > 0 ? 'HANDOFF!' : 'SURVIVED');
  }
  holder.props.stunUntil = Math.max(num(holder.props.stunUntil), t + P.overloadStunSec);
  // the blast knocks bystanders back (physics: props too)
  if (ctx.physics) ctx.physics.blast(holder.x, holder.y, OVERLOAD_BLAST * 1.4, 420);
  else for (const p of ctx.players) {
    const e = p.id === victim ? undefined : ctx.entityOf(p.id);
    if (!e || isOut(e)) continue;
    const dx = e.x - holder.x, dy = e.y - holder.y, d = len(dx, dy);
    if (d > OVERLOAD_BLAST || d < 1) continue;
    const k = 420 * (1 - d / OVERLOAD_BLAST);
    e.vx += (dx / d) * k;
    e.vy += (dy / d) * k;
  }
  ctx.world.remove(core.id);
  callout(U(ctx), P.callout, 'overload', victim, { penalty: P.overloadPenalty, reward: P.overloadReward, passer: c.passer || null });
  ctx.emit({ type: 'arena.detonate', player: victim });
  c.coreId = undefined;
  c.holder = '';
  c.passer = '';
  c.nextSpawnAt = t + RESPAWN_CORE_SEC;
  ctx.fx({ kind: 'flash', color: '#FF3355' });
  ctx.fx({ kind: 'shake', strength: 0.6 });
  ctx.fx({ kind: 'particles', preset: 'burst', x: holder.x, y: holder.y });
  ctx.fx({ kind: 'sfx', name: 'explode' });
}

/** Speed multiplier for an avatar under overload (a holder is a little faster). */
export function overloadSpeed(ctx: Ctx, o: OverloadState | undefined, id: string): number {
  return o && holding(o, id) ? ctx.params.overloadHolderSpeed : 1;
}

export function overloadBot(ctx: Ctx, o: OverloadState, id: string, skill: number, dash: DashInfo, key: string): InputFrame | undefined {
  const e = ctx.entityOf(id);
  if (!e) return undefined;
  const m = botMem(o.bots, id);
  const sk = clamp(skill, 0, 1);
  const { width: w, height: h } = ctx.world;
  const frame = (axes: { x: number; y: number }, press = false): InputFrame => {
    const f: InputFrame = { t: 0, axes };
    if (key) f.buttons = { [key]: press };
    return f;
  };
  if (holding(o, id)) {
    // chase the nearest rival that can take it
    let best: Entity | undefined, bd = Infinity;
    for (const p of ctx.players) {
      if (p.id === id || (o.immuneUntil.get(p.id) ?? 0) > ctx.time || holding(o, p.id)) continue;
      const r = ctx.entityOf(p.id);
      if (!canHold(ctx, r)) continue;
      const d = len(r.x - e.x, r.y - e.y);
      if (d < bd) { bd = d; best = r; }
    }
    if (!best) return frame({ x: 0, y: 0 });
    const lead = 0.15 + 0.35 * sk;
    const axes = steer(U(ctx), m, e, best.x + best.vx * lead, best.y + best.vy * lead, 0.4 + 0.6 * sk);
    const tx = best.x - e.x, ty = best.y - e.y, td = len(tx, ty) || 1;
    const facing = (dash.face.x * tx + dash.face.y * ty) / td;
    const press = dash.ready && td < 170 && facing > 0.8 && ctx.rng.next() < 0.05 + 0.25 * sk;
    return frame(axes, press);
  }
  // flee the nearest holder
  let hz: Entity | undefined, hd = Infinity;
  for (const c of o.cores) {
    const he = c.holder ? ctx.entityOf(c.holder) : undefined;
    if (!he) continue;
    const d = len(e.x - he.x, e.y - he.y);
    if (d < hd) { hd = d; hz = he; }
  }
  if (!hz) return undefined;
  const dx = e.x - hz.x, dy = e.y - hz.y, d = len(dx, dy) || 1;
  const alarm = 260 + 160 * sk;
  if (d > alarm) return undefined; // relax: wander (arena-move's base bot)
  // flee: away from the holder, pushed off walls, sliding along them instead of cornering
  let fx = dx / d, fy = dy / d;
  const edge = 140;
  if (e.x < edge) fx += ((edge - e.x) / edge) * 1.4;
  if (e.x > w - edge) fx -= ((e.x - (w - edge)) / edge) * 1.4;
  if (e.y < edge) fy += ((edge - e.y) / edge) * 1.4;
  if (e.y > h - edge) fy -= ((e.y - (h - edge)) / edge) * 1.4;
  // cornered: break sideways past the holder
  if (len(fx, fy) < 0.35) { fx = -dy / d; fy = dx / d; }
  const wob = (1 - sk) * 0.6;
  const a = Math.atan2(fy, fx) + ctx.rng.range(-wob, wob);
  const axes = { x: Math.cos(a), y: Math.sin(a) };
  const closing = (hz.vx * dx + hz.vy * dy) / d;
  const press = dash.ready && d < 120 && closing > 100 && ctx.rng.next() < 0.05 + 0.3 * sk;
  return frame(axes, press);
}

// ---------------------------------------------------------------- PAINT

export interface PaintState {
  cols: number;
  rows: number;
  tw: number;
  th: number;
  tiles: Entity[];
  nextTallyAt: number;
  finalDone: boolean;
  /** Paint key per player: team (team games) else join slot. */
  keyOf: Map<string, number>;
  /** Score weight per player: the smaller team scores more per tile (odd player counts). */
  weight: Map<string, number>;
  bots: Map<string, BotMem>;
}

export function paintSetup(ctx: Ctx): PaintState {
  const P = ctx.params;
  const { width: w, height: h } = ctx.world;
  const cols = P.paintCols, rows = P.paintRows;
  const tw = w / cols, th = h / rows;
  const tiles: Entity[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push(ctx.world.spawn('tile', (c + 0.5) * tw, (r + 0.5) * th, {
        sprite: 'tile', r: Math.max(tw, th) * 0.71,
        props: { hw: tw / 2, hh: th / 2, col: c, row: r, paint: -1, paintedBy: '', paintTeam: -1 },
      }));
    }
  }
  const keyOf = new Map<string, number>();
  const weight = new Map<string, number>();
  const teams = ctx.players.some((p) => p.team !== undefined);
  const size = [0, 0];
  for (const p of ctx.players) if (p.team !== undefined) size[p.team]!++;
  const big = Math.max(size[0]!, size[1]!);
  ctx.players.forEach((p, i) => {
    keyOf.set(p.id, teams && p.team !== undefined ? p.team : i);
    // auto-balance odd teams: a smaller team's tiles are worth more
    weight.set(p.id, teams && p.team !== undefined && size[p.team]! > 0 ? big / size[p.team]! : 1);
  });
  return { cols, rows, tw, th, tiles, nextTallyAt: P.paintEverySec, finalDone: false, keyOf, weight, bots: new Map() };
}

function tileAt(s: PaintState, x: number, y: number): Entity | undefined {
  const c = Math.floor(x / s.tw), r = Math.floor(y / s.th);
  if (c < 0 || r < 0 || c >= s.cols || r >= s.rows) return undefined;
  return s.tiles[r * s.cols + c];
}

function paintTile(s: PaintState, t: Entity, id: string, team: number): void {
  t.props.paint = s.keyOf.get(id) ?? -1;
  t.props.paintedBy = id;
  t.props.paintTeam = team;
  if (team === 0 || team === 1) t.team = team;
}

/** Dash burst: paint a (2b+1)² block of tiles around (x, y). */
export function paintBurst(ctx: Ctx, s: PaintState, id: string, x: number, y: number): void {
  const b = ctx.params.paintBurst + (ctx.params.paintUnderdog && behind(ctx, id) ? 1 : 0);
  const c0 = Math.floor(x / s.tw), r0 = Math.floor(y / s.th);
  const team = ctx.players.find((p) => p.id === id)?.team ?? -1;
  for (let r = r0 - b; r <= r0 + b; r++) {
    for (let c = c0 - b; c <= c0 + b; c++) {
      if (c < 0 || r < 0 || c >= s.cols || r >= s.rows) continue;
      paintTile(s, s.tiles[r * s.cols + c]!, id, team);
    }
  }
  ctx.fx({ kind: 'particles', preset: 'burst', x, y });
}

/** Is `id` (its team, in team games) strictly behind the leader on score? */
function behind(ctx: Ctx, id: string): boolean {
  const me = ctx.players.find((p) => p.id === id);
  if (!me) return false;
  if (me.team !== undefined) {
    const t = [0, 0];
    for (const p of ctx.players) if (p.team !== undefined) t[p.team]! += p.score;
    return t[me.team]! < t[1 - me.team]!;
  }
  return ctx.players.some((p) => p.score > me.score);
}

/** Tile share per paint key (0..1). */
export function paintShares(s: PaintState): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of s.tiles) {
    const k = num(t.props.paint, -1);
    if (k >= 0) out.set(k, (out.get(k) ?? 0) + 1);
  }
  for (const [k, n] of out) out.set(k, n / s.tiles.length);
  return out;
}

function tally(ctx: Ctx, s: PaintState, final: boolean): void {
  const P = ctx.params;
  const owned = new Map<string, number>();
  for (const t of s.tiles) {
    const by = t.props.paintedBy;
    if (typeof by === 'string' && by) owned.set(by, (owned.get(by) ?? 0) + 1);
  }
  const mul = final ? P.paintFinalMul : 1;
  for (const p of ctx.players) {
    const n = owned.get(p.id) ?? 0;
    const pts = Math.round((P.paintPoints * n * (s.weight.get(p.id) ?? 1) * mul) / s.tiles.length);
    if (pts > 0) ctx.score(p.id, pts, final ? 'FINAL TALLY' : 'TERRITORY');
  }
  const shares: Record<string, number> = {};
  for (const [k, v] of paintShares(s)) shares[k] = Math.round(v * 1000) / 1000;
  callout(U(ctx), P.callout, final ? 'tally.final' : 'tally', undefined, { shares, final });
  ctx.fx({ kind: 'sfx', name: final ? 'win' : 'tick' });
}

export function paintUpdate(ctx: Ctx, s: PaintState, dt: number): void {
  for (const p of ctx.players) {
    const e = ctx.entityOf(p.id);
    if (!e || isOut(e) || isStunned(U(ctx), e)) continue;
    const t = tileAt(s, e.x, e.y);
    if (t && t.props.paintedBy !== p.id) paintTile(s, t, p.id, p.team ?? -1);
  }
  if (ctx.remaining <= dt + 1e-9) {
    if (!s.finalDone) { s.finalDone = true; tally(ctx, s, true); }
    return;
  }
  if (ctx.time >= s.nextTallyAt) {
    s.nextTallyAt += ctx.params.paintEverySec;
    tally(ctx, s, false);
  }
}

export function paintBot(ctx: Ctx, s: PaintState, id: string, skill: number, dash: DashInfo, key: string): InputFrame {
  const e = ctx.entityOf(id);
  if (!e) return { t: 0 };
  const m = botMem(s.bots, id);
  const sk = clamp(skill, 0, 1);
  const me = ctx.players.find((p) => p.id === id);
  const myKey = s.keyOf.get(id) ?? -1;
  const enemy = (o: string) => {
    if (o === id) return false;
    const op = ctx.players.find((p) => p.id === o);
    return !(me?.team !== undefined && op?.team === me.team);
  };
  const cur = m.targetId !== undefined ? ctx.world.get(m.targetId) : undefined;
  if (!cur || cur.props.paint === myKey || ctx.time >= m.until) {
    // sample candidate tiles; prefer near, enemy-painted, and away from teammates
    let best = Infinity;
    m.targetId = undefined;
    for (let k = 0; k < 14; k++) {
      const t = s.tiles[ctx.rng.int(0, s.tiles.length - 1)]!;
      if (t.props.paint === myKey) continue;
      let c = len(t.x - e.x, t.y - e.y);
      if (num(t.props.paint, -1) >= 0) c -= 60 * sk;
      for (const p of ctx.players) {
        if (p.id === id || enemy(p.id)) continue;
        const o = ctx.entityOf(p.id);
        if (o && len(o.x - t.x, o.y - t.y) < 160) c += 120 * sk;
      }
      c += ctx.rng.range(0, 150) * (1 - sk);
      if (c < best) { best = c; m.targetId = t.id; }
    }
    m.until = ctx.time + ctx.rng.range(0.6, 1.2) + (1 - sk) * 0.6;
  }
  const t = m.targetId !== undefined ? ctx.world.get(m.targetId) : undefined;
  const axes = t ? steer(U(ctx), m, e, t.x, t.y, sk) : { x: 0, y: 0 };
  const f: InputFrame = { t: 0, axes };
  if (!key) return f;
  let press = false;
  if (dash.ready) {
    // shove an enemy close ahead, or burst-paint on an unpainted patch
    for (const p of ctx.players) {
      if (!enemy(p.id)) continue;
      const o = ctx.entityOf(p.id);
      if (!o) continue;
      const dx = o.x - e.x, dy = o.y - e.y, d = len(dx, dy);
      if (d < 130 && d > 1 && (dx * dash.face.x + dy * dash.face.y) / d > 0.85 && ctx.rng.next() < 0.05 + 0.2 * sk) press = true;
    }
    const here = tileAt(s, e.x, e.y);
    if (!press && here && here.props.paint !== myKey && ctx.rng.next() < 0.01 + 0.03 * sk) press = true;
  }
  f.buttons = { [key]: press };
  return f;
}
