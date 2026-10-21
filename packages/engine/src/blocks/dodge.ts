import { z } from 'zod';
import type { BlockCtx, BlockDef } from '../block';
import type { Entity } from '../world';
import {
  AVATAR_R, type BotMem, type Vec, FALLBACK_SPEED, botMem, clamp, ensureAvatars, fallbackMove, inputDir, len, stateOf,
} from './util';

const PATTERNS = ['rain', 'sweep', 'chase', 'ring'] as const;
type Pattern = (typeof PATTERNS)[number];

// ---------- bot planning ----------

interface Threat { x: number; y: number; vx: number; vy: number; r: number; armIn: number; expireIn: number }

const SAFE_CLEARANCE = 45;
const WALL_LOOKAHEAD = 3;
const BOT_DIRS: Vec[] = [{ x: 0, y: 0 }];
for (let k = 0; k < 12; k++) BOT_DIRS.push({ x: Math.cos((k / 12) * Math.PI * 2), y: Math.sin((k / 12) * Math.PI * 2) });

/** Hazards a bot has noticed (older than its reaction time) within a relevant range. */
function botThreats(ctx: BlockCtx<DodgeParams>, s: State, e: Entity, reaction: number): Threat[] {
  const out: Threat[] = [];
  const tele = ctx.params.telegraphMs / 1000;
  for (const [id, hz] of s.hz) {
    const h = ctx.world.get(id);
    if (!h || ctx.time - (hz.armAt - tele) < reaction) continue;
    const armed = h.props.armed === true;
    const vx = armed ? h.vx : hz.avx, vy = armed ? h.vy : hz.avy;
    if (len(h.x - e.x, h.y - e.y) > 420 + len(vx, vy)) continue;
    out.push({ x: h.x, y: h.y, vx, vy, r: h.r, armIn: Math.max(0, hz.armAt - ctx.time), expireIn: hz.expireAt - ctx.time });
  }
  return out;
}

/** Worst predicted gap (px) between the avatar moving along `d` and any live hazard. */
function clearance(ctx: BlockCtx<DodgeParams>, e: Entity, threats: Threat[], d: Vec, speed: number, horizon: number): number {
  const { width: w, height: h } = ctx.world;
  let worst = 200;
  for (let i = 1; i <= 4; i++) {
    const t = (horizon * i) / 4;
    const px = clamp(e.x + d.x * speed * t, e.r, w - e.r), py = clamp(e.y + d.y * speed * t, e.r, h - e.r);
    for (const th of threats) {
      if (t < th.armIn || t > th.expireIn) continue;
      const mv = t - th.armIn;
      const g = len(th.x + th.vx * mv - px, th.y + th.vy * mv - py) - th.r - e.r;
      if (g < worst) worst = g;
    }
    // corners are traps
    const wall = Math.min(px - e.r, w - e.r - px, py - e.r, h - e.r - py);
    if (wall < 30) worst = Math.min(worst, worst - (30 - wall));
  }
  return worst;
}

interface Wall { axis: 'x' | 'y'; gap: number; ttr: number }

/** Sweep walls that will reach the avatar within WALL_LOOKAHEAD seconds. */
function approachingWalls(ctx: BlockCtx<DodgeParams>, s: State, e: Entity): Wall[] {
  const out: Wall[] = [];
  for (const [gid, g] of s.groups) {
    let pos: number | undefined, v = 0, delay = 0;
    for (const [id, hz] of s.hz) {
      if (hz.group !== gid) continue;
      const h = ctx.world.get(id);
      if (!h) continue;
      pos = g.axis === 'x' ? h.x : h.y;
      v = g.axis === 'x' ? hz.avx : hz.avy;
      delay = Math.max(0, hz.armAt - ctx.time);
      break;
    }
    if (pos === undefined || v === 0) continue;
    const ttr = ((g.axis === 'x' ? e.x : e.y) - pos) / v + delay;
    if (ttr > -0.2 && ttr < WALL_LOOKAHEAD) out.push({ axis: g.axis, gap: g.gap, ttr });
  }
  return out;
}

/** Score bonus for moving toward the gaps of walls that are about to arrive. */
function gapPull(e: Entity, walls: Wall[], d: Vec): number {
  let pull = 0;
  for (const w of walls) {
    const off = w.gap - (w.axis === 'x' ? e.y : e.x);
    if (Math.abs(off) < 12) continue;
    const urgency = 1 - Math.max(0, w.ttr) / WALL_LOOKAHEAD;
    pull += (w.axis === 'x' ? d.y : d.x) * Math.sign(off) * (20 + 60 * urgency);
  }
  return pull;
}

export const dodgeSchema = z.object({
  hazardSprite: z.string().min(1).max(40),
  pattern: z.enum(PATTERNS),
  /** Waves per second at the start (scaled per pattern: sweeps and rings are bigger). */
  startRate: z.number().min(0.1).max(10),
  /** Added to the wave rate every second. */
  rampPerSec: z.number().min(0).max(0.5),
  maxRate: z.number().min(0.5).max(20),
  /** Warning time before a hazard can hurt anyone. Never below 400 ms: hits must be fair. */
  telegraphMs: z.number().int().min(400).max(3000),
  hazardSpeed: z.number().min(60).max(900),
  hazardRadius: z.number().min(8).max(80),
  onHit: z.enum(['eliminate', 'losePoints', 'stun']),
  /** Points lost per hit when onHit is losePoints (score never drops below 0). */
  hitPenalty: z.number().int().min(0).max(50),
  stunSec: z.number().min(0.3).max(5),
  /** Grace period after a hit: no double hits. */
  invulnSec: z.number().min(0.3).max(5),
  /** Points for every surviveEverySec without being hit. */
  survivePoints: z.number().int().min(0).max(10),
  surviveEverySec: z.number().min(0.5).max(10),
  /** Points for an armed hazard passing close without hitting. */
  nearMissPoints: z.number().int().min(0).max(10),
  /** Circles where hazards can't hurt you; they relocate every safeZoneShiftSec. */
  safeZones: z.number().int().min(0).max(4),
  safeZoneRadius: z.number().min(40).max(200),
  safeZoneShiftSec: z.number().min(3).max(60),
});
export type DodgeParams = z.infer<typeof dodgeSchema>;

interface Hz {
  pattern: Pattern;
  armAt: number;
  expireAt: number;
  avx: number;
  avy: number;
  group: number;
  near?: Set<string>;
  hit?: Set<string>;
}

interface Group {
  /** Sweep only: the wall moves along this axis; the gap is centred at `gap` on the other one. */
  axis: 'x' | 'y';
  gap: number;
}

interface State {
  hz: Map<number, Hz>;
  groups: Map<number, Group>;
  nextGroup: number;
  acc: number;
  zones: number[];
  nextZoneShift: number;
  nextSurvive: number;
  lastHit: Map<string, number>;
  intents: Map<string, Vec>;
  bots: Map<string, BotMem & { freezeUntil?: number }>;
}

const states = new WeakMap<object, State>();
const S = (ctx: object) =>
  stateOf<State>(states, ctx, () => ({
    hz: new Map(), groups: new Map(), nextGroup: 1, acc: 0, zones: [], nextZoneShift: 0, nextSurvive: 0,
    lastHit: new Map(), intents: new Map(), bots: new Map(),
  }));

/** Relative wave cost: big patterns come less often for the same rate. */
const WAVE_WEIGHT: Record<Pattern, number> = { rain: 1, chase: 0.5, sweep: 0.25, ring: 0.3 };
const RAIN_SCALE = 1.8;
const RAIN_IMPACT_SEC = 0.35;
const CHASE_LIFE_SEC = 6;
const CHASE_SPEED = 0.55;
const CHASE_TURN = 2.5; // rad/s
const RING_COUNT = 12;
const NEAR_MISS_PX = 30;
const MAX_HAZARDS = 150;
const MAX_WALLS = 2;
const FINALE_BOOST = 1.4;

function addHazard(ctx: BlockCtx<DodgeParams>, s: State, pattern: Pattern, x: number, y: number, r: number, h: Omit<Hz, 'pattern' | 'armAt'>): void {
  const armAt = ctx.time + ctx.params.telegraphMs / 1000;
  const e = ctx.world.spawn('hazard', x, y, {
    sprite: ctx.params.hazardSprite,
    r,
    props: { armed: false, pattern, warnMs: ctx.params.telegraphMs, armAt },
  });
  s.hz.set(e.id, { pattern, armAt, ...h });
}

function liveAvatars(ctx: BlockCtx<DodgeParams>): Entity[] {
  const out: Entity[] = [];
  for (const p of ctx.players) {
    const e = ctx.entityOf(p.id);
    if (e) out.push(e);
  }
  return out;
}

function spawnWave(ctx: BlockCtx<DodgeParams>, s: State, pattern: Pattern): void {
  const P = ctx.params;
  const { width: w, height: h } = ctx.world;
  const rng = ctx.rng;
  const r = P.hazardRadius;
  const tele = P.telegraphMs / 1000;
  const group = s.nextGroup++;
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
      addHazard(ctx, s, pattern, x, y, rr, { expireAt: ctx.time + tele + RAIN_IMPACT_SEC, avx: 0, avy: 0, group });
      break;
    }
    case 'sweep': {
      const side = rng.int(0, 3); // 0 L->R, 1 R->L, 2 T->B, 3 B->T
      const axis: 'x' | 'y' = side < 2 ? 'x' : 'y';
      const span = axis === 'x' ? h : w;
      const gapW = Math.max(150, AVATAR_R * 7);
      const gap = rng.range(gapW / 2 + r, span - gapW / 2 - r);
      s.groups.set(group, { axis, gap });
      const dir = side % 2 === 0 ? 1 : -1;
      const v = P.hazardSpeed * dir;
      for (let c = r; c <= span - r + 0.01; c += r * 2.2) {
        if (Math.abs(c - gap) < gapW / 2) continue;
        const along = dir > 0 ? r : (axis === 'x' ? w : h) - r;
        const x = axis === 'x' ? along : c, y = axis === 'x' ? c : along;
        addHazard(ctx, s, pattern, x, y, r, {
          expireAt: Infinity, avx: axis === 'x' ? v : 0, avy: axis === 'y' ? v : 0, group,
        });
      }
      break;
    }
    case 'chase': {
      const side = rng.int(0, 3);
      const x = side === 0 ? r : side === 1 ? w - r : rng.range(r, w - r);
      const y = side === 2 ? r : side === 3 ? h - r : rng.range(r, h - r);
      addHazard(ctx, s, pattern, x, y, r, { expireAt: ctx.time + tele + CHASE_LIFE_SEC, avx: 0, avy: 0, group });
      break;
    }
    case 'ring': {
      const cx = rng.range(Math.min(150, w / 2), Math.max(w / 2, w - 150));
      const cy = rng.range(Math.min(150, h / 2), Math.max(h / 2, h - 150));
      const skip = rng.int(0, RING_COUNT - 1);
      const sp = P.hazardSpeed * 0.8;
      for (let k = 0; k < RING_COUNT; k++) {
        if (k === skip || k === (skip + 1) % RING_COUNT) continue; // escape gap
        const a = (k / RING_COUNT) * Math.PI * 2;
        addHazard(ctx, s, pattern, cx + Math.cos(a) * 26, cy + Math.sin(a) * 26, r, {
          expireAt: ctx.time + tele + 8, avx: Math.cos(a) * sp, avy: Math.sin(a) * sp, group,
        });
      }
      break;
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

function syncZones(ctx: BlockCtx<DodgeParams>, s: State): void {
  const P = ctx.params;
  const { width: w, height: h } = ctx.world;
  const shift = ctx.time >= s.nextZoneShift;
  while (s.zones.length > P.safeZones) ctx.world.remove(s.zones.pop()!);
  while (s.zones.length < P.safeZones) {
    s.zones.push(ctx.world.spawn('safe-zone', w / 2, h / 2, { sprite: 'safe-zone', r: P.safeZoneRadius }).id);
  }
  for (const id of s.zones) {
    const z = ctx.world.get(id)!;
    z.r = P.safeZoneRadius;
    if (shift) {
      z.x = ctx.rng.range(z.r, w - z.r);
      z.y = ctx.rng.range(z.r, h - z.r);
    }
  }
  if (shift) s.nextZoneShift = ctx.time + P.safeZoneShiftSec;
}

function removeHazard(ctx: BlockCtx<DodgeParams>, s: State, id: number, hz: Hz): void {
  const e = ctx.world.get(id);
  // near misses pay out once the hazard is gone and it never touched them
  if (hz.near && ctx.params.nearMissPoints > 0) {
    for (const pid of hz.near) {
      if (hz.hit?.has(pid)) continue;
      const av = ctx.entityOf(pid);
      if (!av) continue;
      ctx.score(pid, ctx.params.nearMissPoints, 'dodge.nearMiss');
      ctx.emit({ type: 'dodge.nearMiss', player: pid, data: { hazard: id } });
      ctx.fx({ kind: 'particles', preset: 'sparkle', x: av.x, y: av.y });
      ctx.fx({ kind: 'sfx', name: 'whoosh' });
    }
  }
  s.hz.delete(id);
  if (e) ctx.world.remove(id);
  if (hz.pattern === 'sweep' && ![...s.hz.values()].some((o) => o.group === hz.group)) s.groups.delete(hz.group);
}

function hit(ctx: BlockCtx<DodgeParams>, s: State, pid: string, e: Entity, id: number, hz: Hz): boolean {
  const P = ctx.params;
  const t = ctx.time;
  if (typeof e.props.invulnUntil === 'number' && t < e.props.invulnUntil) return false;
  if (inSafeZone(ctx, s, e)) return false;
  (hz.hit ??= new Set()).add(pid);
  s.lastHit.set(pid, t);
  e.props.invulnUntil = t + P.invulnSec;
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
      if (n > 0) ctx.score(pid, -n, 'dodge.hit');
      break;
    }
    case 'stun':
      e.props.stunUntil = t + P.stunSec;
      e.vx = e.vy = 0;
      break;
  }
  return true;
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
      let best: Entity | undefined, bd = Infinity;
      for (const a of avatars) {
        const d = len(a.x - e.x, a.y - e.y);
        if (d < bd) { bd = d; best = a; }
      }
      const sp = ctx.params.hazardSpeed * CHASE_SPEED;
      const cur = e.vx === 0 && e.vy === 0 ? Math.atan2(best!.y - e.y, best!.x - e.x) : Math.atan2(e.vy, e.vx);
      let want = Math.atan2(best!.y - e.y, best!.x - e.x) - cur;
      want = Math.atan2(Math.sin(want), Math.cos(want));
      const a = cur + clamp(want, -CHASE_TURN * dt, CHASE_TURN * dt);
      e.vx = Math.cos(a) * sp;
      e.vy = Math.sin(a) * sp;
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
  },
  controls: ['joystick'],
  arenaKinds: ['topdown'],

  setup(ctx) {
    const s = S(ctx);
    ensureAvatars(ctx as BlockCtx<unknown>, 'dodge');
    syncZones(ctx, s);
    s.nextSurvive = ctx.params.surviveEverySec;
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
    // surprise: an off-pattern wave so the round changes shape mid-way
    const s = S(ctx);
    const others = PATTERNS.filter((p) => p !== ctx.params.pattern);
    spawnWave(ctx, s, ev.kind === 'surprise' ? ctx.rng.pick(others) : ctx.params.pattern);
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
      if (s.hz.size >= MAX_HAZARDS) continue;
      // at most two walls at once: crossing walls stay readable and escapable
      if (P.pattern === 'sweep' && s.groups.size >= MAX_WALLS) continue;
      spawnWave(ctx, s, P.pattern);
    }

    stepHazards(ctx, s, dt);
    collide(ctx, s);

    if (ctx.time >= s.nextSurvive) {
      s.nextSurvive = ctx.time + P.surviveEverySec;
      let any = false;
      for (const p of ctx.players) {
        if (!ctx.entityOf(p.id)) continue;
        if (ctx.time - (s.lastHit.get(p.id) ?? -Infinity) < P.surviveEverySec) continue;
        if (P.survivePoints > 0) {
          ctx.score(p.id, P.survivePoints, 'dodge.survive');
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

    const threats = botThreats(ctx, s, e, 0.15 + (1 - sk) * 0.45);
    const walls = approachingWalls(ctx, s, e).filter((w) => Math.abs(w.gap - (w.axis === 'x' ? e.y : e.x)) > 12);
    if (threats.length === 0 && walls.length === 0) return { t: 0 };
    const horizon = 0.35 + 0.45 * sk;
    const speed = Math.max(len(e.vx, e.vy), FALLBACK_SPEED * 0.8);

    // keep going if the current heading (set by movement/collect bots) is already safe
    const sp = len(e.vx, e.vy);
    const cur = sp > 20 ? { x: e.vx / sp, y: e.vy / sp } : { x: 0, y: 0 };
    if (walls.length === 0 && clearance(ctx, e, threats, cur, speed, horizon) > SAFE_CLEARANCE) return { t: 0 };

    let best = cur, bestScore = -Infinity;
    for (const d of BOT_DIRS) {
      let score = clearance(ctx, e, threats, d, speed, horizon);
      score += gapPull(e, walls, d); // sweeping walls: head for the gap
      score += (d.x * cur.x + d.y * cur.y) * 6; // prefer smooth turns over jitter
      if (score > bestScore) { bestScore = score; best = d; }
    }
    m.wobble = clamp(m.wobble + ctx.rng.range(-1, 1) * (1 - sk) * 0.2, -(1 - sk) * 0.7, (1 - sk) * 0.7);
    if (best.x === 0 && best.y === 0) return { t: 0, axes: { x: 0, y: 0 } };
    const a = Math.atan2(best.y, best.x) + m.wobble;
    return { t: 0, axes: { x: Math.cos(a), y: Math.sin(a) } };
  },
};
