import { z } from 'zod';
import type { InputFrame } from '@cadabra/spec';
import type { BlockCtx, BlockDef } from '../block';
import type { Entity } from '../world';
import {
  type BotMem, type MoveCaps, type Vec, botMem, callout, clamp, ensureAvatars, escapeTime, fallbackMove, inputDir, labelOf,
  len, moveCaps, onFloor, stateOf,
} from './util';

const PATTERNS = ['rain', 'sweep', 'chase', 'ring'] as const;
type Pattern = (typeof PATTERNS)[number];

export const dodgeSchema = z.object({
  hazardSprite: z.string().min(1).max(40).describe('Sprite key for hazards (art resolved by the renderer).'),
  pattern: z.enum(PATTERNS).describe('rain: drops from above; sweep: walls with gaps; chase: slow homing hunters; ring: bullet rings from a point.'),
  startRate: z.number().min(0.1).max(10).describe('Waves per second at the start (scaled per pattern: sweeps and rings are bigger).'),
  rampPerSec: z.number().min(0).max(0.5).describe('Added to the wave rate every second.'),
  maxRate: z.number().min(0.5).max(20).describe('Cap on the wave rate, waves per second.'),
  telegraphMs: z.number().int().min(400).max(3000).describe('Minimum warning before a hazard can hurt anyone (never below 400 ms). The block lengthens it per hazard when the slowest/largest avatar needs longer to escape.'),
  hazardSpeed: z.number().min(60).max(900).describe('Hazard speed, px/s.'),
  hazardRadius: z.number().min(8).max(80).describe('Hazard size, px.'),
  onHit: z.enum(['eliminate', 'losePoints', 'stun']).describe('What a hit does: eliminate the player, lose hitPenalty points, or stun for stunSec.'),
  hitPenalty: z.number().int().min(0).max(50).describe('Points lost per hit when onHit is losePoints (score never drops below 0).'),
  stunSec: z.number().min(0.3).max(5).describe('Stun length when onHit is stun, s.'),
  invulnSec: z.number().min(0.3).max(5).describe('Grace period after a hit (with stun: at least stunSec + 0.5 s), so no double hits.'),
  survivePoints: z.number().int().min(0).max(10).describe('Points for every surviveEverySec without being hit.'),
  surviveEverySec: z.number().min(0.5).max(10).describe('Seconds between survival payouts.'),
  nearMissPoints: z.number().int().min(0).max(10).describe('Points for an armed hazard passing close without hitting.'),
  safeZones: z.number().int().min(0).max(4).describe("Circles where hazards can't hurt you; they relocate every safeZoneShiftSec."),
  safeZoneRadius: z.number().min(40).max(200).describe('Safe zone size, px.'),
  safeZoneShiftSec: z.number().min(3).max(60).describe('Seconds between safe zone moves.'),
  hitKnockback: z.number().min(0).max(1200).describe('Hits fling the avatar away from the hazard at this speed, px/s (0 = none). Comedy with slippery movement.'),
  knockoutPoints: z.number().int().min(0).max(10).describe('Points to whoever shoved (dash-bumped) the victim into a hazard within the last 1.5 s.'),
  crumbleLastSec: z.number().min(0).max(30).describe("Floor of tiles (kind 'tile') that crumbles from the edges inward in the final N seconds: tiles shake (props.crumbling), then drop; standing over a hole counts as a hit. 0 = no floor."),
  callout: z.string().max(24).describe("Namespace for the headline events the TV calls out (<callout>.knockout, .crumble); '' = off."),
});
export type DodgeParams = z.infer<typeof dodgeSchema>;

interface Hz {
  pattern: Pattern;
  bornAt: number;
  armAt: number;
  expireAt: number;
  avx: number;
  avy: number;
  /** chase only: homing speed */
  speed: number;
  group: number;
  near?: Set<string>;
  hit?: Set<string>;
}

/** A sweep wall: hazards in one line moving along `axis`, with gap corridors across it. */
interface Wall {
  axis: 'x' | 'y';
  dir: 1 | -1;
  /** Centres of the gaps on the cross axis. */
  gaps: number[];
  /** Avatar centre may be within ±half of a gap centre and pass untouched. */
  half: number;
  bornAt: number;
  armAt: number;
  speed: number;
}

interface Floor {
  tiles: number[];
  /** Outer rings that crumble, in order (ring 0 = the edge). */
  rings: number;
  warned: number;
  dropped: number;
  tileW: number;
  tileH: number;
}

interface State {
  floor?: Floor;
  hz: Map<number, Hz>;
  walls: Map<number, Wall>;
  nextGroup: number;
  acc: number;
  zones: number[];
  lastZoneShift: number;
  lastSurvive: number;
  lastHit: Map<string, number>;
  intents: Map<string, Vec>;
  bots: Map<string, BotMem & { freezeUntil?: number }>;
}

const states = new WeakMap<object, State>();
const S = (ctx: object) =>
  stateOf<State>(states, ctx, () => ({
    hz: new Map(), walls: new Map(), nextGroup: 1, acc: 0, zones: [], lastZoneShift: 0, lastSurvive: 0,
    lastHit: new Map(), intents: new Map(), bots: new Map(),
  }));

/** Relative wave cost: big patterns come less often for the same rate. */
const WAVE_WEIGHT: Record<Pattern, number> = { rain: 1, chase: 0.5, sweep: 0.25, ring: 0.3 };
const RAIN_SCALE = 1.8;
const RAIN_IMPACT_SEC = 0.35;
const CHASE_LIFE_SEC = 6;
const CHASE_SPEED = 0.55;
/** Chasers never exceed this fraction of the slowest avatar's speed: always outrunnable. */
const CHASE_MAX_VS_AVATAR = 0.8;
const CHASE_TURN = 2.5; // rad/s
const RING_COUNT = 12;
const RING_START_R = 26;
const RING_SPAWN_CLEAR = 220;
/** Widest per-avatar ring gap (half-angle): keeps a ring a ring. */
const RING_MAX_GAP_HALF = Math.PI / 4;
const NEAR_MISS_PX = 30;
const MAX_HAZARDS = 150;
const MAX_WALLS = 2;
const MAX_CHASERS = 5;
/** Gap centres in a wall are at most this far apart, so the nearest gap is never far. */
const MAX_GAP_SPACING = 400;
/** Extra room either side of the avatar inside a gap. */
const MIN_GAP_PLAY = 24;
const FINALE_BOOST = 1.4;
const STUN_INVULN_PAD = 0.5;
/** A shove counts toward a knockout for this long. */
const KO_WINDOW_SEC = 1.5;
/** Floor tiles are about this big, px. */
const TILE_PX = 128;
/** Minimum warning before a crumbling ring drops, s. */
const CRUMBLE_WARN_SEC = 1.5;
/** The crumble schedule finishes this fraction into the crumble window (the rest is the tense end). */
const CRUMBLE_SPAN = 0.6;
/**
 * Timeline kinds that trigger a bonus wave: 'surprise' (mid-round) fires an off-pattern
 * wave, 'twist' (final 10 s) fires one of the block's own pattern. Other kinds are ignored.
 */
export const DODGE_TIMELINE_KINDS = ['surprise', 'twist'] as const;

function tele(ctx: BlockCtx<DodgeParams>, escapeDist: number, caps: MoveCaps): number {
  return Math.max(ctx.params.telegraphMs / 1000, escapeTime(escapeDist, caps));
}

function addHazard(
  ctx: BlockCtx<DodgeParams>, s: State, pattern: Pattern, x: number, y: number, r: number, teleSec: number,
  h: Omit<Hz, 'pattern' | 'armAt' | 'bornAt' | 'expireAt' | 'speed'> & { life: number; speed?: number },
): void {
  const armAt = ctx.time + teleSec;
  const e = ctx.world.spawn('hazard', x, y, {
    sprite: ctx.params.hazardSprite,
    r,
    // ax/ay: velocity once armed, so the renderer can draw the telegraph's direction
    props: { armed: false, pattern, warnMs: Math.round(teleSec * 1000), armAt, group: h.group, ax: h.avx, ay: h.avy },
  });
  s.hz.set(e.id, {
    pattern, bornAt: ctx.time, armAt, expireAt: armAt + h.life, avx: h.avx, avy: h.avy, speed: h.speed ?? 0, group: h.group,
  });
}

function liveAvatars(ctx: BlockCtx<DodgeParams>): Entity[] {
  const out: Entity[] = [];
  for (const p of ctx.players) {
    const e = ctx.entityOf(p.id);
    if (e) out.push(e);
  }
  return out;
}

/** Leading-edge position of a wall along its axis at time t. */
function wallPos(ctx: BlockCtx<DodgeParams>, w: Wall, r: number, t: number): number {
  const run = w.axis === 'x' ? ctx.world.width : ctx.world.height;
  const start = w.dir > 0 ? r : run - r;
  return start + w.dir * w.speed * Math.max(0, t - w.armAt);
}

/** Largest distance any avatar centre must travel across the wall to reach a gap corridor. */
export function worstGapReach(gaps: number[], half: number, span: number, avatarR: number): number {
  if (gaps.length === 0) return span;
  const g = [...gaps].sort((a, b) => a - b);
  let worst = Math.max(0, g[0]! - half - avatarR, span - avatarR - (g[g.length - 1]! + half));
  for (let i = 1; i < g.length; i++) worst = Math.max(worst, (g[i]! - g[i - 1]! - 2 * half) / 2);
  return worst;
}

/**
 * Which side a new wall may come from, or undefined if none may spawn now. Concurrent
 * walls come from the same side, spaced so that between one wall passing a point and the
 * next arriving, an avatar has time to cross the whole arena to the next wall's gap.
 */
function wallSide(ctx: BlockCtx<DodgeParams>, s: State, caps: MoveCaps): number | undefined {
  if (s.walls.size >= MAX_WALLS) return undefined;
  if (s.walls.size === 0) return ctx.rng.int(0, 3);
  const spanMax = Math.max(ctx.world.width, ctx.world.height);
  const needGap = escapeTime(spanMax, caps) - ctx.params.telegraphMs / 1000;
  let side: number | undefined;
  for (const w of s.walls.values()) {
    if (ctx.time < w.armAt || ctx.time - w.armAt < needGap) return undefined;
    side = (w.axis === 'x' ? 0 : 2) + (w.dir > 0 ? 0 : 1);
  }
  return side;
}

function spawnSweep(ctx: BlockCtx<DodgeParams>, s: State, caps: MoveCaps, side: number): void {
  const P = ctx.params;
  const { width: w, height: h } = ctx.world;
  const r = P.hazardRadius;
  const axis: 'x' | 'y' = side < 2 ? 'x' : 'y';
  const dir: 1 | -1 = side % 2 === 0 ? 1 : -1;
  const span = axis === 'x' ? h : w;
  const play = Math.max(caps.r, MIN_GAP_PLAY);
  // nearest hazard centre is r + avatar r + play from a gap centre; 2 px kept as margin
  const gapHalfW = r + caps.r + play;
  const half = play - 2;
  // gaps at most MAX_GAP_SPACING apart, but each gap cell keeps room for a real wall
  // (huge hazards / avatars => fewer gaps; the telegraph below grows to compensate)
  const fit = Math.floor(span / (2 * gapHalfW + 2 * 2.2 * r));
  const n = Math.max(1, Math.min(Math.ceil(span / MAX_GAP_SPACING), fit));
  const spacing = span / n;
  const off = ctx.rng.range(-0.2, 0.2) * spacing;
  const gaps: number[] = [];
  for (let k = 0; k < n; k++) gaps.push(clamp((k + 0.5) * spacing + off, Math.min(gapHalfW, span / 2), Math.max(span / 2, span - gapHalfW)));
  const teleSec = tele(ctx, worstGapReach(gaps, half, span, caps.r), caps);
  const group = s.nextGroup++;
  const wall: Wall = { axis, dir, gaps, half, bornAt: ctx.time, armAt: ctx.time + teleSec, speed: P.hazardSpeed };
  s.walls.set(group, wall);
  const v = P.hazardSpeed * dir;
  const along = dir > 0 ? r : (axis === 'x' ? w : h) - r;
  for (let c = r; c <= span - r + 0.01; c += r * 2.2) {
    if (gaps.some((g) => Math.abs(c - g) < gapHalfW)) continue;
    addHazard(ctx, s, 'sweep', axis === 'x' ? along : c, axis === 'x' ? c : along, r, teleSec, {
      life: Infinity, avx: axis === 'x' ? v : 0, avy: axis === 'y' ? v : 0, group,
    });
  }
}

/** Spawns one wave; returns false if caps (hazard count, concurrent walls) forbid it. */
function spawnWave(ctx: BlockCtx<DodgeParams>, s: State, pattern: Pattern): boolean {
  if (s.hz.size >= MAX_HAZARDS) return false;
  const P = ctx.params;
  const { width: w, height: h } = ctx.world;
  const rng = ctx.rng;
  const r = P.hazardRadius;
  const caps = moveCaps(ctx as BlockCtx<unknown>);
  switch (pattern) {
    case 'rain': {
      const rr = r * RAIN_SCALE;
      const av = liveAvatars(ctx);
      let x = rng.range(rr, w - rr), y = rng.range(rr, h - rr);
      // half the drops land near someone so standing still is never safe
      if (av.length > 0 && rng.next() < 0.5) {
        const t = rng.pick(av);
        x = clamp(t.x + rng.range(-120, 120), rr, w - rr);
        y = clamp(t.y + rng.range(-120, 120), rr, h - rr);
      }
      // worst case: avatar dead centre must clear the whole blast
      addHazard(ctx, s, pattern, x, y, rr, tele(ctx, rr + caps.r + 2, caps), {
        life: RAIN_IMPACT_SEC, avx: 0, avy: 0, group: s.nextGroup++,
      });
      return true;
    }
    case 'sweep': {
      const side = wallSide(ctx, s, caps);
      if (side === undefined) return false;
      spawnSweep(ctx, s, caps, side);
      return true;
    }
    case 'chase': {
      let chasers = 0;
      for (const o of s.hz.values()) if (o.pattern === 'chase') chasers++;
      if (chasers >= MAX_CHASERS) return false; // a swarm of homers can't be outrun
      const side = rng.int(0, 3);
      const x = side === 0 ? r : side === 1 ? w - r : rng.range(r, w - r);
      const y = side === 2 ? r : side === 3 ? h - r : rng.range(r, h - r);
      const speed = Math.min(P.hazardSpeed * CHASE_SPEED, caps.speed * CHASE_MAX_VS_AVATAR);
      addHazard(ctx, s, pattern, x, y, r, tele(ctx, r + caps.r + 2, caps), {
        life: CHASE_LIFE_SEC, avx: 0, avy: 0, speed, group: s.nextGroup++,
      });
      return true;
    }
    case 'ring': {
      // centre away from everyone where possible: rings are read, then sidestepped
      const av = liveAvatars(ctx);
      let cx = w / 2, cy = h / 2;
      for (let tries = 0; tries < 12; tries++) {
        cx = rng.range(Math.min(150, w / 2), Math.max(w / 2, w - 150));
        cy = rng.range(Math.min(150, h / 2), Math.max(h / 2, h - 150));
        if (!av.some((a) => len(a.x - cx, a.y - cy) < RING_SPAWN_CLEAR)) break;
      }
      // Fairness: every avatar gets a gap centred on its own bearing from the ring centre,
      // wide enough that at its distance (or at RING_SAFE_FLOOR, if it is closer) the nearest
      // bullet ray passes at least r + R + 2 + slack away. Avatars inside the floor must walk
      // out along their bearing before the ring arms; the telegraph is sized for that.
      const slack = Math.max(caps.r, MIN_GAP_PLAY);
      const need = r + caps.r + 2 + slack;
      const floor = need / Math.sin(RING_MAX_GAP_HALF);
      const gaps: { phi: number; alpha: number }[] = [];
      let escape = 0;
      for (const a of av) {
        const rho = len(a.x - cx, a.y - cy);
        gaps.push({ phi: Math.atan2(a.y - cy, a.x - cx), alpha: Math.asin(Math.min(1, need / Math.max(rho, floor))) });
        escape = Math.max(escape, floor - rho);
      }
      const rot = rng.range(0, (Math.PI * 2) / RING_COUNT);
      const skip = rng.int(0, RING_COUNT - 1);
      const sp = P.hazardSpeed * 0.8;
      const teleSec = tele(ctx, escape, caps);
      const group = s.nextGroup++;
      for (let k = 0; k < RING_COUNT; k++) {
        if (k === skip || k === (skip + 1) % RING_COUNT) continue; // a general escape gap
        const a = rot + (k / RING_COUNT) * Math.PI * 2;
        if (gaps.some((g) => Math.abs(Math.atan2(Math.sin(a - g.phi), Math.cos(a - g.phi))) < g.alpha)) continue;
        addHazard(ctx, s, pattern, cx + Math.cos(a) * RING_START_R, cy + Math.sin(a) * RING_START_R, r, teleSec, {
          life: 8, avx: Math.cos(a) * sp, avy: Math.sin(a) * sp, group,
        });
      }
      return true;
    }
  }
}

function inSafeZone(ctx: BlockCtx<DodgeParams>, s: State, e: Entity): boolean {
  for (const id of s.zones) {
    const z = ctx.world.get(id);
    if (z && len(e.x - z.x, e.y - z.y) <= z.r) return true;
  }
  return false;
}

function placeZone(ctx: BlockCtx<DodgeParams>, z: Entity): void {
  const { width: w, height: h } = ctx.world;
  z.x = ctx.rng.range(Math.min(z.r, w / 2), Math.max(w / 2, w - z.r));
  z.y = ctx.rng.range(Math.min(z.r, h / 2), Math.max(h / 2, h - z.r));
}

function syncZones(ctx: BlockCtx<DodgeParams>, s: State): void {
  const P = ctx.params;
  while (s.zones.length > P.safeZones) ctx.world.remove(s.zones.pop()!);
  while (s.zones.length < P.safeZones) {
    const z = ctx.world.spawn('safe-zone', 0, 0, { sprite: 'safe-zone', r: P.safeZoneRadius });
    placeZone(ctx, z);
    s.zones.push(z.id);
  }
  // derived from the last shift, so a live interval change applies at once
  const shift = ctx.time >= s.lastZoneShift + P.safeZoneShiftSec;
  if (shift) s.lastZoneShift = ctx.time;
  for (const id of s.zones) {
    const z = ctx.world.get(id)!;
    z.r = P.safeZoneRadius;
    if (shift) placeZone(ctx, z);
  }
}

function removeHazard(ctx: BlockCtx<DodgeParams>, s: State, id: number, hz: Hz): void {
  // near misses pay out once the hazard is gone and it never touched them
  if (hz.near && ctx.params.nearMissPoints > 0) {
    for (const pid of hz.near) {
      if (hz.hit?.has(pid)) continue;
      const av = ctx.entityOf(pid);
      if (!av) continue;
      ctx.score(pid, ctx.params.nearMissPoints, 'Close call!');
      ctx.emit({ type: 'dodge.nearMiss', player: pid, data: { hazard: id } });
      ctx.fx({ kind: 'particles', preset: 'sparkle', x: av.x, y: av.y });
      ctx.fx({ kind: 'sfx', name: 'whoosh' });
    }
  }
  s.hz.delete(id);
  ctx.world.remove(id);
  if (hz.pattern === 'sweep' && s.walls.has(hz.group)) {
    let left = false;
    for (const o of s.hz.values()) if (o.group === hz.group) { left = true; break; }
    if (!left) s.walls.delete(hz.group);
  }
}

/** Knockback direction: along a moving hazard's travel, else straight away from `from`. */
function knock(e: Entity, from: Vec, vel: Vec, speed: number): void {
  if (speed <= 0) return;
  const vl = len(vel.x, vel.y);
  let dx = e.x - from.x, dy = e.y - from.y;
  const dl = len(dx, dy);
  if (vl > 1) {
    // mostly with the wave, a little away from the blob that hit
    dx = vel.x / vl + (dl > 0 ? (0.5 * dx) / dl : 0);
    dy = vel.y / vl + (dl > 0 ? (0.5 * dy) / dl : 0);
  }
  const l = len(dx, dy) || 1;
  e.vx = (dx / l) * speed;
  e.vy = (dy / l) * speed;
}

function hit(ctx: BlockCtx<DodgeParams>, s: State, pid: string, e: Entity, id: number, hz: Hz, from?: Vec): boolean {
  const P = ctx.params;
  const t = ctx.time;
  if (typeof e.props.invulnUntil === 'number' && t < e.props.invulnUntil) return false;
  if (inSafeZone(ctx, s, e)) return false;
  (hz.hit ??= new Set()).add(pid);
  s.lastHit.set(pid, t);
  const src = ctx.world.get(id);
  const origin = from ?? (src ? { x: src.x, y: src.y } : { x: e.x, y: e.y });
  // who shoved them in? (a dash bump moments ago)
  const by = e.props.shovedBy, at = e.props.shovedAt;
  if (typeof by === 'string' && by !== pid && typeof at === 'number' && t - at <= KO_WINDOW_SEC) {
    delete e.props.shovedBy;
    delete e.props.shovedAt;
    if (P.knockoutPoints > 0) ctx.score(by, P.knockoutPoints, 'Knockout!');
    ctx.emit({ type: 'dodge.knockout', player: by, data: { victim: pid } });
    callout(ctx as BlockCtx<unknown>, P.callout, 'knockout', by, { victim: pid });
  }
  // a stunned avatar can't move, so it must not be hittable until it can again
  e.props.invulnUntil = t + (P.onHit === 'stun' ? Math.max(P.invulnSec, P.stunSec + STUN_INVULN_PAD) : P.invulnSec);
  ctx.emit({ type: 'dodge.hit', player: pid, data: { hazard: id, pattern: hz.pattern, onHit: P.onHit } });
  ctx.fx({ kind: 'particles', preset: 'burst', x: e.x, y: e.y });
  ctx.fx({ kind: 'shake', strength: 0.6 });
  ctx.fx({ kind: 'flash', color: '#ff3b3b' });
  ctx.fx({ kind: 'sfx', name: 'hit' });
  switch (P.onHit) {
    case 'eliminate':
      ctx.fx({ kind: 'sfx', name: 'lose' });
      ctx.eliminate(pid);
      break;
    case 'losePoints': {
      const score = ctx.players.find((p) => p.id === pid)?.score ?? 0;
      const n = Math.min(P.hitPenalty, score);
      if (n > 0) ctx.score(pid, -n, `${labelOf(P.hazardSprite)}!`);
      knock(e, origin, { x: hz.avx, y: hz.avy }, P.hitKnockback);
      break;
    }
    case 'stun':
      e.props.stunUntil = t + P.stunSec;
      e.vx = e.vy = 0;
      knock(e, origin, { x: hz.avx, y: hz.avy }, P.hitKnockback);
      break;
  }
  return true;
}

// ---------- crumbling floor ----------

function syncFloor(ctx: BlockCtx<DodgeParams>, s: State): void {
  if (s.floor || ctx.params.crumbleLastSec <= 0) return;
  const { width: w, height: h } = ctx.world;
  const cols = Math.max(3, Math.round(w / TILE_PX)), rows = Math.max(3, Math.round(h / TILE_PX));
  const tw = w / cols, th = h / rows;
  const floor: Floor = { tiles: [], rings: Math.max(1, Math.floor((Math.min(cols, rows) - 1) / 2)), warned: 0, dropped: 0, tileW: tw, tileH: th };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ring = Math.min(c, r, cols - 1 - c, rows - 1 - r);
      const t = ctx.world.spawn('tile', (c + 0.5) * tw, (r + 0.5) * th, {
        sprite: 'tile', r: Math.min(tw, th) / 2, props: { hw: tw / 2, hh: th / 2, ring, col: c, row: r, crumbling: false },
      });
      floor.tiles.push(t.id);
    }
  }
  s.floor = floor;
}

/** Ring k warns at this many seconds before the end. */
function ringWarnAt(P: DodgeParams, f: Floor, k: number): number {
  return P.crumbleLastSec * (1 - (CRUMBLE_SPAN * k) / f.rings);
}

function stepFloor(ctx: BlockCtx<DodgeParams>, s: State): void {
  const f = s.floor;
  const P = ctx.params;
  if (!f || P.crumbleLastSec <= 0) return;
  const caps = moveCaps(ctx as BlockCtx<unknown>);
  const warn = Math.max(CRUMBLE_WARN_SEC, escapeTime(Math.max(f.tileW, f.tileH), caps));
  const left = ctx.remaining;
  while (f.warned < f.rings && left <= ringWarnAt(P, f, f.warned)) {
    const k = f.warned++;
    for (const id of f.tiles) {
      const t = ctx.world.get(id);
      if (t && t.props.ring === k) {
        t.props.crumbling = true;
        t.props.fallAt = ctx.time + warn;
      }
    }
    callout(ctx as BlockCtx<unknown>, P.callout, 'crumble', undefined, { ring: k, phase: 'warn', warnSec: warn });
    ctx.fx({ kind: 'shake', strength: 0.25 });
    ctx.fx({ kind: 'sfx', name: 'tick' });
  }
  if (f.dropped < f.warned) {
    let fell = false;
    for (const id of f.tiles.slice()) {
      const t = ctx.world.get(id);
      if (!t || t.props.ring !== f.dropped || typeof t.props.fallAt !== 'number' || ctx.time < t.props.fallAt) continue;
      ctx.world.remove(id);
      f.tiles.splice(f.tiles.indexOf(id), 1);
      fell = true;
    }
    if (fell) {
      callout(ctx as BlockCtx<unknown>, P.callout, 'crumble', undefined, { ring: f.dropped, phase: 'fall' });
      ctx.fx({ kind: 'shake', strength: 0.5 });
      ctx.fx({ kind: 'sfx', name: 'lose' });
      f.dropped++;
    }
  }
  if (f.dropped === 0) return;
  // standing over a hole is a hit; the knock sends you back toward solid ground
  const { width: w, height: h } = ctx.world;
  for (const p of ctx.players) {
    const e = ctx.entityOf(p.id);
    if (!e || onFloor(ctx as BlockCtx<unknown>, e.x, e.y)) continue;
    const gap: Hz = { pattern: 'rain', bornAt: ctx.time, armAt: ctx.time, expireAt: ctx.time, avx: 0, avy: 0, speed: 0, group: 0 };
    const from = { x: e.x + (e.x - w / 2), y: e.y + (e.y - h / 2) };
    hit(ctx, s, p.id, e, -1, gap, from);
  }
}

function stepHazards(ctx: BlockCtx<DodgeParams>, s: State, dt: number): void {
  const { width: w, height: h } = ctx.world;
  const t = ctx.time;
  const avatars = liveAvatars(ctx);
  for (const [id, hz] of s.hz) {
    const e = ctx.world.get(id);
    if (!e || t >= hz.expireAt || e.x < -e.r || e.x > w + e.r || e.y < -e.r || e.y > h + e.r) {
      removeHazard(ctx, s, id, hz);
      continue;
    }
    if (t < hz.armAt) continue; // telegraphing: stationary and harmless
    if (!e.props.armed) {
      e.props.armed = true;
      e.vx = hz.avx;
      e.vy = hz.avy;
    }
    if (hz.pattern === 'chase' && avatars.length > 0) {
      let best = avatars[0]!, bd = Infinity;
      for (const a of avatars) {
        const d = len(a.x - e.x, a.y - e.y);
        if (d < bd) { bd = d; best = a; }
      }
      const to = Math.atan2(best.y - e.y, best.x - e.x);
      const cur = e.vx === 0 && e.vy === 0 ? to : Math.atan2(e.vy, e.vx);
      let turn = to - cur;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      const a = cur + clamp(turn, -CHASE_TURN * dt, CHASE_TURN * dt);
      e.vx = Math.cos(a) * hz.speed;
      e.vy = Math.sin(a) * hz.speed;
    }
  }
}

function collide(ctx: BlockCtx<DodgeParams>, s: State): void {
  for (const p of ctx.players) {
    const e = ctx.entityOf(p.id);
    if (!e) continue;
    for (const [id, hz] of s.hz) {
      const h = ctx.world.get(id);
      if (!h || !h.props.armed) continue;
      const d = len(h.x - e.x, h.y - e.y);
      if (d <= h.r + e.r) {
        if (hit(ctx, s, p.id, e, id, hz) && hz.pattern !== 'rain') removeHazard(ctx, s, id, hz);
        if (!ctx.entityOf(p.id)) break; // eliminated
      } else if (d <= h.r + e.r + NEAR_MISS_PX) {
        (hz.near ??= new Set()).add(p.id);
      }
    }
  }
}

// ---------- bot planning ----------

/** `homing` > 0: a chaser, modelled as a pursuer closing in at that speed. */
interface Threat { x: number; y: number; vx: number; vy: number; r: number; armIn: number; expireIn: number; homing: number }

/** Bots hand steering back to other blocks only with this much predicted room (px). */
const SAFE_CLEARANCE = 110;
const WALL_LOOKAHEAD = 3;
const WALL_MARGIN = 110;
const BOT_DIRS: Vec[] = [{ x: 0, y: 0 }];
for (let k = 0; k < 12; k++) BOT_DIRS.push({ x: Math.cos((k / 12) * Math.PI * 2), y: Math.sin((k / 12) * Math.PI * 2) });

/** Hazards a bot has noticed (older than its reaction time) within a relevant range. */
function botThreats(ctx: BlockCtx<DodgeParams>, s: State, e: Entity, reaction: number): Threat[] {
  const out: Threat[] = [];
  for (const [id, hz] of s.hz) {
    const h = ctx.world.get(id);
    if (!h || ctx.time - hz.bornAt < reaction) continue;
    const armed = h.props.armed === true;
    const vx = armed ? h.vx : hz.avx, vy = armed ? h.vy : hz.avy;
    if (len(h.x - e.x, h.y - e.y) > 420 + len(vx, vy) + hz.speed) continue;
    const homing = hz.pattern === 'chase' ? hz.speed : 0;
    out.push({ x: h.x, y: h.y, vx, vy, r: h.r, armIn: Math.max(0, hz.armAt - ctx.time), expireIn: hz.expireAt - ctx.time, homing });
  }
  return out;
}

/** Worst predicted gap (px) between the avatar moving along `d` and any live hazard. */
function clearance(ctx: BlockCtx<DodgeParams>, e: Entity, threats: Threat[], d: Vec, speed: number, horizon: number): number {
  const { width: w, height: h } = ctx.world;
  let worst = 200;
  for (let i = 1; i <= 5; i++) {
    const t = (horizon * i) / 5;
    const px = clamp(e.x + d.x * speed * t, e.r, w - e.r), py = clamp(e.y + d.y * speed * t, e.r, h - e.r);
    for (const th of threats) {
      if (t < th.armIn || t > th.expireIn) continue;
      const mv = t - th.armIn;
      const g = th.homing > 0
        ? len(th.x - px, th.y - py) - th.homing * mv - th.r - e.r
        : len(th.x + th.vx * mv - px, th.y + th.vy * mv - py) - th.r - e.r;
      if (g < worst) worst = g;
    }
    // walls and corners are traps (pursuers pin you there): keep to open floor
    const wall = Math.min(px - e.r, w - e.r - px, py - e.r, h - e.r - py);
    if (wall < WALL_MARGIN) worst -= WALL_MARGIN - wall;
  }
  return worst;
}

interface WallView { axis: 'x' | 'y'; off: number; half: number; ttr: number }

/** Walls reaching this avatar within WALL_LOOKAHEAD s, with the offset to their nearest gap. */
function approachingWalls(ctx: BlockCtx<DodgeParams>, s: State, e: Entity, reaction: number): WallView[] {
  const out: WallView[] = [];
  const r = ctx.params.hazardRadius;
  for (const w of s.walls.values()) {
    if (ctx.time - w.bornAt < reaction) continue;
    const along = w.axis === 'x' ? e.x : e.y;
    const pos = wallPos(ctx, w, r, ctx.time);
    const ttr = (along - pos) / (w.dir * w.speed) + Math.max(0, w.armAt - ctx.time);
    if (ttr < -0.3 || ttr > WALL_LOOKAHEAD) continue;
    const across = w.axis === 'x' ? e.y : e.x;
    let off = Infinity;
    for (const g of w.gaps) if (Math.abs(g - across) < Math.abs(off)) off = g - across;
    out.push({ axis: w.axis, off, half: w.half, ttr });
  }
  return out;
}

export const dodge: BlockDef<DodgeParams> = {
  id: 'dodge',
  name: 'Dodge',
  summary: 'Telegraphed hazards (rain, sweeping walls, chasers, bullet rings) ramp up; survive, skim close for near-miss points.',
  paramsSchema: dodgeSchema,
  defaults: {
    hazardSprite: 'hazard',
    pattern: 'rain',
    startRate: 0.8,
    rampPerSec: 0.03,
    maxRate: 4,
    telegraphMs: 700,
    hazardSpeed: 300,
    hazardRadius: 22,
    onHit: 'losePoints',
    hitPenalty: 3,
    stunSec: 1.2,
    invulnSec: 1.5,
    survivePoints: 1,
    surviveEverySec: 2,
    nearMissPoints: 1,
    safeZones: 0,
    safeZoneRadius: 90,
    safeZoneShiftSec: 10,
    hitKnockback: 0,
    knockoutPoints: 0,
    crumbleLastSec: 0,
    callout: 'play',
  },
  controls: ['joystick'],
  arenaKinds: ['topdown'],
  requiredControls: () => [{ kind: 'joystick', id: '', alt: [{ kind: 'tilt', id: '' }] }],

  setup(ctx) {
    const s = S(ctx);
    ensureAvatars(ctx as BlockCtx<unknown>, 'dodge');
    syncZones(ctx, s);
    syncFloor(ctx, s);
    // a short grace before the first wave
    s.acc = -0.5;
  },

  onInput(ctx, playerId, input) {
    const e = ctx.entityOf(playerId);
    if (!e || e.props.mover !== 'dodge') return;
    const s = S(ctx);
    let d = s.intents.get(playerId);
    if (!d) s.intents.set(playerId, (d = { x: 0, y: 0 }));
    inputDir(input, 'joystick', 1.5, d);
  },

  onTimeline(ctx, ev) {
    const s = S(ctx);
    if (ev.kind === 'surprise') {
      // an off-pattern wave so the round changes shape mid-way (falls back if capped)
      const others = PATTERNS.filter((p) => p !== ctx.params.pattern);
      const first = ctx.rng.pick(others);
      if (!spawnWave(ctx, s, first)) spawnWave(ctx, s, 'rain');
    } else if (ev.kind === 'twist') {
      spawnWave(ctx, s, ctx.params.pattern);
    }
  },

  update(ctx, dt) {
    const s = S(ctx);
    const P = ctx.params;
    syncZones(ctx, s);

    let rate = Math.min(P.maxRate, P.startRate + P.rampPerSec * ctx.time);
    if (ctx.remaining <= 10) rate *= FINALE_BOOST;
    s.acc += rate * WAVE_WEIGHT[P.pattern] * dt;
    while (s.acc >= 1) {
      s.acc -= 1;
      spawnWave(ctx, s, P.pattern);
    }

    stepHazards(ctx, s, dt);
    collide(ctx, s);
    syncFloor(ctx, s);
    stepFloor(ctx, s);

    if (ctx.time >= s.lastSurvive + P.surviveEverySec) {
      s.lastSurvive = ctx.time;
      let any = false;
      for (const p of ctx.players) {
        if (!ctx.entityOf(p.id)) continue;
        if (ctx.time - (s.lastHit.get(p.id) ?? -Infinity) < P.surviveEverySec) continue;
        if (P.survivePoints > 0) {
          ctx.score(p.id, P.survivePoints, 'Survived!');
          any = true;
        }
      }
      if (any) ctx.fx({ kind: 'sfx', name: 'tick' });
    }

    fallbackMove(ctx as BlockCtx<unknown>, 'dodge', s.intents, dt);
  },

  bot(ctx, playerId, skill) {
    const s = S(ctx);
    const e = ctx.entityOf(playerId);
    if (!e) return { t: 0 };
    const sk = clamp(skill, 0, 1);
    const m = botMem(s.bots, playerId) as BotMem & { freezeUntil?: number };
    // occasional brain-freeze: plausible, and gives humans a chance
    if (ctx.rng.next() < (1 - sk) * 0.01) m.freezeUntil = ctx.time + 0.3;
    if (m.freezeUntil !== undefined && ctx.time < m.freezeUntil) return { t: 0 };

    const reaction = 0.15 + (1 - sk) * 0.45;
    // crumbling floor: get onto stable ground (aim for the middle), skating carefully
    if (s.floor && s.floor.warned > 0) {
      const lead = 0.25 + 0.25 * sk;
      const fx = e.x + e.vx * lead, fy = e.y + e.vy * lead;
      if (!onFloor(ctx as BlockCtx<unknown>, e.x, e.y, true) || !onFloor(ctx as BlockCtx<unknown>, fx, fy, true)) {
        const { width: w, height: h } = ctx.world;
        const dx = w / 2 - fx, dy = h / 2 - fy, l = len(dx, dy) || 1;
        const dk0 = typeof e.props.dashKey === 'string' && e.props.dashKey !== '' ? e.props.dashKey : undefined;
        const f: InputFrame = { t: 0, axes: { x: dx / l, y: dy / l } };
        if (dk0) f.buttons = { [dk0]: false };
        return f;
      }
    }
    const walls = approachingWalls(ctx, s, e, reaction);
    // a wall is coming and we're not in a gap: walk straight across to the nearest one
    let urgent: WallView | undefined;
    for (const w of walls) {
      if (Math.abs(w.off) >= w.half * 0.5 && (!urgent || w.ttr < urgent.ttr)) urgent = w;
    }
    // precision moves veto the mover's dash (a random dash out of a gap is a hit)
    const dk = typeof e.props.dashKey === 'string' && e.props.dashKey !== '' ? e.props.dashKey : undefined;
    const noDash = dk ? { [dk]: false } : undefined;
    const frame = (axes: Vec, dash = false): InputFrame => {
      const f: InputFrame = { t: 0, axes };
      if (dk) f.buttons = dash ? { [dk]: true } : noDash!;
      return f;
    };
    if (urgent) {
      const m1 = Math.sign(urgent.off) * Math.min(1, Math.abs(urgent.off) / 30);
      const drift = clamp(m.wobble, -0.15, 0.15);
      return frame(urgent.axis === 'x' ? { x: drift, y: m1 } : { x: m1, y: drift });
    }
    // in a gap with a wall about to pass: hold still and let it go by
    if (walls.some((w) => w.ttr < 1.2)) return frame({ x: 0, y: 0 });

    const threats = botThreats(ctx, s, e, reaction);
    if (threats.length === 0) return { t: 0 };
    const horizon = 0.35 + 0.45 * sk;
    const speed = Math.max(len(e.vx, e.vy), moveCaps(ctx as BlockCtx<unknown>).speed * 0.8);
    const sp = len(e.vx, e.vy);
    const cur = sp > 20 ? { x: e.vx / sp, y: e.vy / sp } : { x: 0, y: 0 };
    // comfortably clear: let movement/collect bots steer, but no random dashes near danger
    if (clearance(ctx, e, threats, cur, speed, horizon) > SAFE_CLEARANCE) return dk ? { t: 0, buttons: noDash! } : { t: 0 };

    let best = cur, bestScore = -Infinity;
    for (const d of BOT_DIRS) {
      let score = clearance(ctx, e, threats, d, speed, horizon);
      // commit: stick with the last chosen heading unless another is clearly better
      score += (d.x * cur.x + d.y * cur.y) * 6 + (d.x * m.tx + d.y * m.ty) * 25;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    m.tx = best.x;
    m.ty = best.y;
    m.wobble = clamp(m.wobble + ctx.rng.range(-1, 1) * (1 - sk) * 0.2, -(1 - sk) * 0.7, (1 - sk) * 0.7);
    if (best.x === 0 && best.y === 0) return frame({ x: 0, y: 0 });
    const a = Math.atan2(best.y, best.x) + m.wobble;
    // dash only to escape something about to land, and only good bots think of it
    return frame({ x: Math.cos(a), y: Math.sin(a) }, bestScore < 0 && ctx.rng.next() < sk * 0.3);
  },
};
