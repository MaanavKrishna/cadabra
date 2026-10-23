/**
 * CRATE CRASH (arena-move `crates`): every player owns a square platform zone stacked with
 * physics crates. Knock rivals' crates out of their zone (dash, bump, or blast them with an
 * explosive barrel) for crateKnockPoints; every crateTallySec each player scores
 * crateStandPoints per crate still standing in their zone, and the final tally at the buzzer
 * pays crateFinalMul times. Zones slowly refill (the zone of whoever is last refills first).
 */
import type { InputFrame } from '@cadabra/spec';
import type { BlockCtx } from '../block';
import type { Entity } from '../world';
import type { ArenaMoveParams } from './arena-move';
import type { DashInfo } from './arena-modes';
import { type BotMem, botMem, callout, clamp, len, steer } from './util';

type Ctx = BlockCtx<ArenaMoveParams>;
const U = (ctx: Ctx) => ctx as unknown as BlockCtx<unknown>;
const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d);
/** Seconds a crate stays visible (props.out) after leaving its zone, for the topple/debris animation. */
const OUT_LINGER = 0.7;
/** A knock credits whoever touched the crate (or the barrel / crate that hit it) this recently. */
const CREDIT_SEC = 4;

export interface Zone {
  owner: string;
  slot: number;
  x: number;
  y: number;
  half: number;
  base: Entity;
}

export interface CrateState {
  zones: Zone[];
  /** crate id -> zone index */
  home: Map<number, number>;
  gone: Map<number, number>;
  nextTally: number;
  nextRefill: number;
  finalDone: boolean;
  bots: Map<string, BotMem>;
}

/** Zone centres, ordered so 2 players sit diagonally and 3 use three corners. */
function zoneSpots(w: number, h: number, half: number): [number, number][] {
  const mx = half + 40, my = half + 30;
  return [[mx, my], [w - mx, h - my], [w - mx, my], [mx, h - my]];
}

function stack(ctx: Ctx, s: CrateState, zi: number, n: number): void {
  const z = s.zones[zi]!;
  const ph = ctx.physics;
  if (!ph) return;
  const size = ctx.params.crateSize;
  const step = 50 * size;
  // a tight grid around the zone centre: centre first, then the ring
  const offs: [number, number][] = [[0, 0], [-1, -1], [1, 1], [1, -1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]];
  let placed = 0;
  for (const [ox, oy] of offs) {
    if (placed >= n) break;
    const x = z.x + ox * step, y = z.y + oy * step;
    let free = true;
    for (const id of s.home.keys()) {
      const c = ctx.world.get(id);
      if (c && len(c.x - x, c.y - y) < step * 0.8) { free = false; break; }
    }
    for (const p of ctx.players) {
      const e = ctx.entityOf(p.id);
      if (e && len(e.x - x, e.y - y) < e.r + 30 * size) free = false;
    }
    if (!free) continue;
    const c = ph.spawnProp('crate', x, y, size, { zone: zi, slot: z.slot, damping: 3, out: false, broken: false });
    c.owner = z.owner;
    s.home.set(c.id, zi);
    placed++;
  }
}

const standing = (ctx: Ctx, s: CrateState, zi: number) => {
  let n = 0;
  for (const [id, z] of s.home) if (z === zi && !s.gone.has(id) && ctx.world.get(id)) n++;
  return n;
};

export function crateSetup(ctx: Ctx): CrateState {
  const P = ctx.params;
  const { width: w, height: h } = ctx.world;
  const half = P.crateZoneSize / 2;
  const spots = zoneSpots(w, h, half);
  const s: CrateState = { zones: [], home: new Map(), gone: new Map(), nextTally: P.crateTallySec, nextRefill: P.crateRefillSec, finalDone: false, bots: new Map() };
  ctx.players.forEach((p, i) => {
    const [x, y] = spots[i % spots.length]!;
    const base = ctx.world.spawn('base', x, y, { owner: p.id, r: half, sprite: 'base', props: { home: true, zone: true, slot: i, hw: half, hh: half } });
    if (p.team !== undefined) base.team = p.team;
    s.zones.push({ owner: p.id, slot: i, x, y, half, base });
    // players start beside their zone, towards the middle
    const e = ctx.entityOf(p.id);
    if (e) {
      e.x = x + (w / 2 - x) * 0.45; e.y = y + (h / 2 - y) * 0.45; e.vx = e.vy = 0;
    }
  });
  s.zones.forEach((_, zi) => stack(ctx, s, zi, P.cratesPerZone));
  return s;
}

function tally(ctx: Ctx, s: CrateState, final: boolean): void {
  const P = ctx.params;
  const counts: Record<string, number> = {};
  s.zones.forEach((z, zi) => {
    const n = standing(ctx, s, zi);
    counts[z.owner] = n;
    const pts = n * P.crateStandPoints * (final ? P.crateFinalMul : 1);
    if (pts > 0) ctx.score(z.owner, pts, final ? 'FINAL TALLY' : 'STANDING');
  });
  callout(U(ctx), P.callout, final ? 'tally.final' : 'tally', undefined, { standing: counts, final });
  ctx.fx({ kind: 'sfx', name: final ? 'win' : 'tick' });
}

export function crateUpdate(ctx: Ctx, s: CrateState, dt: number): void {
  const P = ctx.params;
  const t = ctx.time;
  // crates that left their zone: credit the knock, linger for the animation, then go
  for (const [id, zi] of s.home) {
    const c = ctx.world.get(id);
    if (!c) { s.home.delete(id); s.gone.delete(id); continue; }
    const out = s.gone.get(id);
    if (out !== undefined) {
      if (t >= out) { ctx.world.remove(id); s.home.delete(id); s.gone.delete(id); }
      continue;
    }
    const z = s.zones[zi]!;
    if (Math.abs(c.x - z.x) <= z.half && Math.abs(c.y - z.y) <= z.half) continue;
    c.props.out = true;
    c.props.broken = true;
    c.props.outAt = t;
    s.gone.set(id, t + OUT_LINGER);
    const by = typeof c.props.touchedBy === 'string' && t - num(c.props.touchedAt, -99) <= CREDIT_SEC ? c.props.touchedBy : '';
    const credited = by !== '' && by !== z.owner;
    if (credited && P.crateKnockPoints > 0) ctx.score(by, P.crateKnockPoints, 'CRATE CRASH!');
    callout(U(ctx), P.callout, 'crash', credited ? by : undefined, { victim: z.owner, x: c.x, y: c.y, credited });
    ctx.fx({ kind: 'particles', preset: 'smoke', x: c.x, y: c.y });
  }
  if (ctx.remaining <= dt + 1e-9) {
    if (!s.finalDone) { s.finalDone = true; tally(ctx, s, true); }
    return;
  }
  if (t >= s.nextTally) { s.nextTally += P.crateTallySec; tally(ctx, s, false); }
  if (P.crateRefillSec > 0 && t >= s.nextRefill) {
    s.nextRefill += P.crateRefillSec;
    // refill one crate per zone; the zone of whoever is last gets two
    let low = Infinity;
    for (const p of ctx.players) low = Math.min(low, p.score);
    s.zones.forEach((z, zi) => {
      const missing = P.cratesPerZone - standing(ctx, s, zi);
      if (missing <= 0) return;
      const last = (ctx.players.find((p) => p.id === z.owner)?.score ?? 0) === low;
      stack(ctx, s, zi, Math.min(missing, last ? 2 : 1));
    });
  }
}

/** Timeline hook: every zone back to full (a "crate drop"). */
export function crateRefillAll(ctx: Ctx, s: CrateState): void {
  s.zones.forEach((_, zi) => stack(ctx, s, zi, ctx.params.cratesPerZone - standing(ctx, s, zi)));
  callout(U(ctx), ctx.params.callout, 'refill', undefined, {});
  ctx.fx({ kind: 'sfx', name: 'crate' });
}

/** Bot: line up behind a rival crate (on its zone-centre side) and dash it out; sometimes guard home. */
export function crateBot(ctx: Ctx, s: CrateState, id: string, skill: number, dash: DashInfo, key: string): InputFrame {
  const e = ctx.entityOf(id);
  if (!e) return { t: 0 };
  const m = botMem(s.bots, id);
  const sk = clamp(skill, 0, 1);
  const { width: w, height: h } = ctx.world;
  let target = m.targetId !== undefined ? ctx.world.get(m.targetId) : undefined;
  if (!target || s.gone.has(target.id) || ctx.time >= m.until) {
    m.targetId = undefined;
    let best = Infinity;
    // candidates: rival crates (and barrels near rival zones), nearest + random spice
    for (const [cid, zi] of s.home) {
      if (s.zones[zi]!.owner === id || s.gone.has(cid)) continue;
      const c = ctx.world.get(cid);
      if (!c) continue;
      const cost = len(c.x - e.x, c.y - e.y) + ctx.rng.range(0, 260) * (1 - sk * 0.6);
      if (cost < best) { best = cost; m.targetId = cid; }
    }
    for (const b of ctx.world.ofKind('barrel')) {
      const cost = len(b.x - e.x, b.y - e.y) * 0.8 + ctx.rng.range(0, 200);
      if (cost < best && b.props.exploded !== true) { best = cost; m.targetId = b.id; }
    }
    m.until = ctx.time + ctx.rng.range(1.5, 3);
    target = m.targetId !== undefined ? ctx.world.get(m.targetId) : undefined;
  }
  if (!target) return { t: 0, axes: steer(U(ctx), m, e, w / 2, h / 2, sk) };
  // push direction: crates go out of their zone (away from its centre); barrels go towards the nearest rival zone
  let ux: number, uy: number;
  if (target.kind === 'barrel') {
    let bz: Zone | undefined, bd = Infinity;
    for (const z of s.zones) {
      if (z.owner === id) continue;
      const d = len(z.x - target.x, z.y - target.y);
      if (d < bd) { bd = d; bz = z; }
    }
    ux = (bz?.x ?? w / 2) - target.x; uy = (bz?.y ?? h / 2) - target.y;
  } else {
    const z = s.zones[s.home.get(target.id) ?? 0]!;
    ux = target.x - z.x; uy = target.y - z.y;
    if (len(ux, uy) < 8) { ux = target.x - w / 2; uy = target.y - h / 2; }
  }
  const ul = len(ux, uy) || 1;
  ux /= ul; uy /= ul;
  const back = target.r + e.r + 12;
  const px = target.x - ux * back, py = target.y - uy * back;
  const d = len(target.x - e.x, target.y - e.y) || 1;
  const along = ((e.x - target.x) * ux + (e.y - target.y) * uy) / d;
  let tx = px, ty = py;
  if (along > -0.2) {
    const sx = -uy, sy = ux;
    const sgn = (e.x - target.x) * sx + (e.y - target.y) * sy >= 0 ? 1 : -1;
    tx = target.x + sx * sgn * back * 1.5 - ux * back * 0.5;
    ty = target.y + sy * sgn * back * 1.5 - uy * back * 0.5;
  } else if (len(px - e.x, py - e.y) < 24) {
    tx = target.x + ux * 60; ty = target.y + uy * 60;
  }
  const axes = steer(U(ctx), m, e, clamp(tx, e.r, w - e.r), clamp(ty, e.r, h - e.r), sk);
  if (!key) return { t: 0, axes };
  const aligned = ((target.x - e.x) * ux + (target.y - e.y) * uy) / d;
  const press = dash.ready && d < 130 && aligned > 0.7 && ctx.rng.next() < 0.08 + 0.25 * sk;
  return { t: 0, axes, buttons: { [key]: press } };
}
