import { z } from 'zod';
import type { TimelineEvent } from '@cadabra/spec';
import type { BlockCtx, BlockDef } from '../block';
import type { Entity } from '../world';
import {
  type BotMem, type Vec, boostOf, botMem, callout, clamp, ensureAvatars, fallbackMove, inputDir, isStunned, labelOf, len, stateOf,
  steer,
} from './util';

export const sneakSchema = z.object({
  guardSprite: z.string().min(1).max(40).describe('Sprite key for the guard (bear, grandma, cat...).'),
  guardKind: z.enum(['sleeper', 'patrol', 'watcher']).describe('sleeper: dozes until noise wakes it. patrol: walks a loop, sees ahead. watcher: stands still, sweeps its gaze.'),
  guardCount: z.number().int().min(1).max(4).describe('Number of guards.'),
  noiseLimit: z.number().min(10).max(1000).describe('Noise a guard tolerates before it wakes.'),
  noisePerMove: z.number().min(1).max(500).describe('Noise per second of full-speed movement right next to a guard (falls off with distance).'),
  noiseDecayPerSec: z.number().min(0).max(500).describe('Noise a calm guard forgets per second.'),
  hearingRadius: z.number().min(100).max(1200).describe('Movement farther than this from a guard makes no noise for it, px.'),
  tiptoeButton: z.string().min(1).max(32).describe('Controller hold/button id: while held, avatars creep (slower, ~silent, invisible to calm guards).'),
  tiptoeSpeedFactor: z.number().min(0.1).max(1).describe('Top-speed multiplier while tiptoeing.'),
  wakeDurationSec: z.number().min(1).max(15).describe('How long a woken guard stays awake (after a short wind-up telegraph), s.'),
  wakePenalty: z.number().int().min(0).max(20).describe('Points lost by whoever woke the guard, and by anyone it then catches moving.'),
  visionConeDeg: z.number().min(15).max(180).describe("Full angle of the guard's vision cone, degrees."),
  visionRange: z.number().min(80).max(1000).describe('How far a guard sees, px.'),
  daringPoints: z.number().int().min(0).max(10).describe('Points per few seconds spent creeping close to a calm guard (0 = off).'),
  onWake: z.enum(['stare', 'chase']).describe("What a woken guard does. stare: stands and catches anyone moving in its vision cone. chase: runs after the loudest player (the culprit) for chaseSec; a catch makes them drop everything they carry and tumble."),
  chaseSec: z.number().min(1).max(10).describe("onWake 'chase': how long the guard chases before it gives up and plods home to sleep, s."),
  chaseSpeed: z.number().min(60).max(600).describe("onWake 'chase': guard run speed, px/s (set it between a loaded and an empty player's speed so greed is risky)."),
  callout: z.string().max(24).describe("Namespace for the headline events the TV calls out (<callout>.chase.start, .caught); '' = off."),
});
export type SneakParams = z.infer<typeof sneakSchema>;

type Phase = 'calm' | 'waking' | 'awake' | 'return';

interface Guard {
  id: number;
  home: Vec;
  /** Noise as a fraction of noiseLimit (0..1); stored as a fraction so live noiseLimit tweaks rescale it. */
  level: number;
  /** Each player's share of `level` (decays with it): who to blame. */
  contrib: Map<string, number>;
  phase: Phase;
  wokeAt: number;
  culprit: string;
  caught: Set<string>;
  facing: number;
  baseFacing: number;
  pathA: number;
  sweepT: number;
  stirring: boolean;
  /** chase mode: who it is after ('' = nobody). */
  target: string;
}

interface State {
  guards: Guard[];
  built?: { kind: SneakParams['guardKind']; count: number };
  tiptoe: Map<string, boolean>;
  intents: Map<string, Vec>;
  dare: Map<string, number>;
  wakes: Map<string, number>;
  sleepwalkUntil: number;
  bots: Map<string, BotMem & { careless: boolean; nerve: number }>;
}

const states = new WeakMap<object, State>();
const S = (ctx: object) =>
  stateOf<State>(states, ctx, () => ({
    guards: [], tiptoe: new Map(), intents: new Map(), dare: new Map(), wakes: new Map(), sleepwalkUntil: -1, bots: new Map(),
  }));

const GUARD_R = 40;
/** Fraction of noiseLimit at which the guard visibly stirs (telegraph). */
const STIR_AT = 0.7;
/** Seconds between waking and the vision cone going live: time to freeze. */
const WINDUP_SEC = 0.75;
/** Below this speed an avatar counts as frozen (never noisy, never caught). */
const FREEZE_SPEED = 30;
/** Tiptoeing makes this fraction of the noise. */
const TIPTOE_NOISE = 0.1;
/** Noise fraction per second a calm patrol/watcher gains from seeing a non-tiptoeing mover. */
const SIGHT_RATE = 1.2;
const CAUGHT_STUN_SEC = 1;
const PATROL_SPEED = 70;
const WATCH_SWEEP = Math.PI / 3;
const WATCH_PERIOD = 6;
const DARE_SEC = 3;
const DARE_ZONE = 0.6;
/** chase mode: a caught player tumbles this long, knocked away this fast. */
const TUMBLE_SEC = 1.2;
const TUMBLE_KNOCK = 340;
/** chase mode: the guard plods home at this fraction of chaseSpeed. */
const RETURN_SPEED = 0.55;
/** Loudness (props.loud) at which a player counts as fully loud. */
const LOUD_FULL = 2.5;

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function inCone(g: Entity, facing: number, P: SneakParams, e: Entity): boolean {
  const dx = e.x - g.x, dy = e.y - g.y;
  const d = len(dx, dy);
  if (d > P.visionRange + e.r) return false;
  if (d < g.r + e.r) return true; // right on top of it
  return Math.abs(wrapAngle(Math.atan2(dy, dx) - facing)) <= (P.visionConeDeg * Math.PI) / 360;
}

function sleepwalking(ctx: BlockCtx<SneakParams>, s: State): boolean {
  return ctx.time < s.sleepwalkUntil;
}

/** Vision is live: awake guards always; calm patrols/watchers while calm. Sleepers see nothing calm. */
function visionOn(P: SneakParams, g: Guard): boolean {
  if (g.phase === 'awake') return P.onWake === 'stare';
  return g.phase === 'calm' && P.guardKind !== 'sleeper';
}

function patrolRadii(ctx: BlockCtx<SneakParams>): Vec {
  const n = ctx.params.guardCount;
  return { x: Math.min(220, ctx.world.width / (2 * (n + 1))), y: Math.min(140, ctx.world.height * 0.2) };
}

/** (Re)build guards when kind/count change (setup and live tweaks). */
function syncGuards(ctx: BlockCtx<SneakParams>, s: State): void {
  const P = ctx.params;
  if (s.built && s.built.kind === P.guardKind && s.built.count === P.guardCount) return;
  for (const g of s.guards) ctx.world.remove(g.id);
  s.guards = [];
  const { width: w, height: h } = ctx.world;
  for (let i = 0; i < P.guardCount; i++) {
    const home = { x: (w * (i + 1)) / (P.guardCount + 1), y: h / 2 };
    const baseFacing = Math.PI / 2 + (i % 2 ? Math.PI : 0);
    const ent = ctx.world.spawn('guard', home.x, home.y, { sprite: P.guardSprite, r: GUARD_R, props: {} });
    s.guards.push({
      id: ent.id, home, level: 0, contrib: new Map(), phase: 'calm', wokeAt: 0, culprit: '', caught: new Set(),
      facing: baseFacing, baseFacing, pathA: (i * Math.PI) / 2, sweepT: 0, stirring: false, target: '',
    });
  }
  s.built = { kind: P.guardKind, count: P.guardCount };
}

function publish(ctx: BlockCtx<SneakParams>, g: Guard, ent: Entity): void {
  const P = ctx.params;
  ent.sprite = P.guardSprite;
  ent.props.guardKind = P.guardKind;
  ent.props.phase = g.phase;
  ent.props.awake = g.phase === 'awake';
  ent.props.waking = g.phase === 'waking';
  ent.props.stirring = g.stirring;
  ent.props.noise = clamp(g.level, 0, 1);
  ent.props.facing = g.facing;
  ent.props.visionConeDeg = P.visionConeDeg;
  ent.props.visionRange = P.visionRange;
  ent.props.visionOn = visionOn(P, g);
  ent.props.hearingRadius = P.hearingRadius;
  ent.props.culprit = g.culprit;
  ent.props.onWake = P.onWake;
  ent.props.chaseTarget = P.onWake === 'chase' && (g.phase === 'waking' || g.phase === 'awake') ? g.culprit : '';
  ent.props.chasing = P.onWake === 'chase' && g.phase === 'awake';
  ent.props.returning = g.phase === 'return';
}

/** How much noise the avatar makes right now, as a multiple of a normal full-speed walk. */
function loudness(s: State, id: string, e: Entity): number {
  const sp = len(e.vx, e.vy);
  if (sp < FREEZE_SPEED) return 0;
  // full effort is noisy: a loaded avatar running at its (slower) top speed counts as full speed
  const load = typeof e.props.loadMul === 'number' ? e.props.loadMul : 1;
  const top = (typeof e.props.topSpeed === 'number' ? e.props.topSpeed : sp) * boostOf(e) * load;
  const mul = typeof e.props.noiseMul === 'number' ? e.props.noiseMul : 1;
  return clamp(sp / top, 0, 1) * ((s.tiptoe.get(id) ?? false) ? TIPTOE_NOISE : 1) * mul;
}

function penalize(ctx: BlockCtx<SneakParams>, id: string, reason: string): number {
  const p = ctx.players.find((q) => q.id === id);
  const n = Math.min(ctx.params.wakePenalty, Math.max(0, p?.score ?? 0));
  if (n > 0) ctx.score(id, -n, reason);
  return n;
}

/**
 * The guard starts waking: it turns to the culprit and telegraphs (sneak.waking). The
 * penalty and sneak.woke only land once the wind-up is over (fullyAwake), so even a
 * sight-triggered wake gives everyone WINDUP_SEC to freeze.
 */
function wake(ctx: BlockCtx<SneakParams>, g: Guard, ent: Entity): void {
  // blame the biggest noise-maker (ties: join order)
  let culprit = '', best = -1;
  for (const p of ctx.players) {
    const c = g.contrib.get(p.id) ?? 0;
    if (c > best) { best = c; culprit = p.id; }
  }
  g.phase = 'waking';
  g.wokeAt = ctx.time;
  g.culprit = culprit;
  g.caught = new Set();
  g.stirring = true;
  const ce = ctx.entityOf(culprit);
  if (ce) g.facing = Math.atan2(ce.y - ent.y, ce.x - ent.x);
  ctx.emit({ type: 'sneak.waking', player: culprit, data: { guard: ent.id, guardKind: ctx.params.guardKind, windupSec: WINDUP_SEC } });
  ctx.fx({ kind: 'sfx', name: 'wake' });
  ctx.fx({ kind: 'particles', preset: 'burst', x: ent.x, y: ent.y - ent.r });
}

/** End of the wind-up: the guard is awake, the culprit pays and sneak.woke fires. */
function fullyAwake(ctx: BlockCtx<SneakParams>, s: State, g: Guard, ent: Entity): void {
  g.phase = 'awake';
  const culprit = g.culprit;
  const count = (s.wakes.get(culprit) ?? 0) + 1;
  s.wakes.set(culprit, count);
  s.dare.set(culprit, 0);
  const penalty = penalize(ctx, culprit, `Woke the ${labelOf(ctx.params.guardSprite).toLowerCase()}!`);
  ctx.emit({ type: 'sneak.woke', player: culprit, data: { guard: ent.id, guardKind: ctx.params.guardKind, count, penalty } });
  ctx.fx({ kind: 'flash', color: '#ff3b30' });
  ctx.fx({ kind: 'shake', strength: 0.4 });
  if (ctx.params.onWake === 'chase' && culprit && ctx.entityOf(culprit)) {
    g.target = culprit;
    callout(ctx as BlockCtx<unknown>, ctx.params.callout, 'chase.start', culprit, { guard: ent.id, sec: ctx.params.chaseSec });
    ctx.fx({ kind: 'sfx', name: 'whoosh' });
  }
}

/** chase mode: the guard runs at its target; a touch is a catch. Returns true when the chase is over. */
function chase(ctx: BlockCtx<SneakParams>, g: Guard, ent: Entity, dt: number): boolean {
  const P = ctx.params;
  const e = g.target ? ctx.entityOf(g.target) : undefined;
  if (!e || ctx.time >= g.wokeAt + WINDUP_SEC + P.chaseSec) return true;
  const dx = e.x - ent.x, dy = e.y - ent.y, d = len(dx, dy) || 1;
  g.facing = Math.atan2(dy, dx);
  if (d <= ent.r + e.r) {
    // caught: drop the loot (any carrying block honours fumbleAt), tumble away
    e.props.fumbleAt = ctx.time;
    e.props.stunUntil = ctx.time + TUMBLE_SEC;
    e.vx = (dx / d) * TUMBLE_KNOCK;
    e.vy = (dy / d) * TUMBLE_KNOCK;
    const carry = typeof e.props.carry === 'number' ? e.props.carry : 0;
    ctx.emit({ type: 'sneak.caught', player: g.target, data: { guard: ent.id, penalty: 0, carry } });
    callout(ctx as BlockCtx<unknown>, P.callout, 'caught', g.target, { guard: ent.id, dropped: carry });
    ctx.fx({ kind: 'shake', strength: 0.5 });
    ctx.fx({ kind: 'sfx', name: 'hit' });
    ctx.fx({ kind: 'particles', preset: 'burst', x: e.x, y: e.y });
    return true;
  }
  const step = Math.min(d, P.chaseSpeed * dt);
  ent.x = clamp(ent.x + (dx / d) * step, ent.r, ctx.world.width - ent.r);
  ent.y = clamp(ent.y + (dy / d) * step, ent.r, ctx.world.height - ent.r);
  return false;
}

/** Walk home after a chase; true once there. */
function walkHome(ctx: BlockCtx<SneakParams>, g: Guard, ent: Entity, dt: number): boolean {
  const dx = g.home.x - ent.x, dy = g.home.y - ent.y, d = len(dx, dy);
  if (d < 2) {
    ent.x = g.home.x;
    ent.y = g.home.y;
    return true;
  }
  const step = Math.min(d, ctx.params.chaseSpeed * RETURN_SPEED * dt);
  ent.x += (dx / d) * step;
  ent.y += (dy / d) * step;
  g.facing = Math.atan2(dy, dx);
  return false;
}

function fallAsleep(ctx: BlockCtx<SneakParams>, g: Guard, ent: Entity): void {
  g.phase = 'calm';
  g.level = 0;
  g.contrib.clear();
  g.stirring = false;
  g.culprit = '';
  g.target = '';
  g.facing = g.baseFacing;
  ctx.emit({ type: 'sneak.sleep', data: { guard: ent.id } });
}

function moveGuard(ctx: BlockCtx<SneakParams>, s: State, g: Guard, ent: Entity, dt: number): void {
  const P = ctx.params;
  const walks = P.guardKind === 'patrol' || (P.guardKind === 'sleeper' && sleepwalking(ctx, s));
  if (g.phase !== 'calm') return; // a woken guard stands and stares
  if (walks) {
    const r = patrolRadii(ctx);
    g.pathA += (PATROL_SPEED / ((r.x + r.y) / 2)) * dt;
    ent.x = g.home.x + Math.cos(g.pathA) * r.x;
    ent.y = g.home.y + Math.sin(g.pathA) * r.y;
    g.facing = Math.atan2(Math.cos(g.pathA) * r.y, -Math.sin(g.pathA) * r.x);
  } else {
    ent.x = g.home.x;
    ent.y = g.home.y;
    if (P.guardKind === 'watcher') {
      g.sweepT += dt;
      g.facing = g.baseFacing + Math.sin((g.sweepT / WATCH_PERIOD) * Math.PI * 2) * WATCH_SWEEP;
    } else {
      g.facing = g.baseFacing;
    }
  }
}

export const sneak: BlockDef<SneakParams> = {
  id: 'sneak',
  name: 'Sneak',
  summary: 'Creep past guards: moving makes noise, hold Tiptoe to stay quiet. Wake the guard and it stares; get caught moving and you lose points.',
  paramsSchema: sneakSchema,
  defaults: {
    guardSprite: 'guard',
    guardKind: 'sleeper',
    guardCount: 1,
    noiseLimit: 100,
    noisePerMove: 60,
    noiseDecayPerSec: 12,
    hearingRadius: 420,
    tiptoeButton: 'tiptoe',
    tiptoeSpeedFactor: 0.4,
    wakeDurationSec: 4,
    wakePenalty: 2,
    visionConeDeg: 70,
    visionRange: 380,
    daringPoints: 1,
    onWake: 'stare',
    chaseSec: 3,
    chaseSpeed: 220,
    callout: 'play',
  },
  controls: ['joystick', 'hold', 'button'],
  arenaKinds: ['topdown'],
  requiredControls: (p) => [
    { kind: 'joystick', id: '', alt: [{ kind: 'tilt', id: '' }] },
    { kind: 'hold', id: p.tiptoeButton, param: 'tiptoeButton', alt: [{ kind: 'button', id: p.tiptoeButton }] },
  ],

  setup(ctx) {
    const s = S(ctx);
    ensureAvatars(ctx as BlockCtx<unknown>, 'sneak');
    syncGuards(ctx, s);
    for (const g of s.guards) {
      const ent = ctx.world.get(g.id);
      if (ent) publish(ctx, g, ent);
    }
  },

  onInput(ctx, playerId, input) {
    const s = S(ctx);
    const tip = input.buttons?.[ctx.params.tiptoeButton] ?? false;
    s.tiptoe.set(playerId, tip);
    const e = ctx.entityOf(playerId);
    if (!e) return;
    e.props.tiptoe = tip;
    e.props.speedMul = tip ? ctx.params.tiptoeSpeedFactor : 1;
    if (e.props.mover !== 'sneak') return;
    let d = s.intents.get(playerId);
    if (!d) s.intents.set(playerId, (d = { x: 0, y: 0 }));
    inputDir(input, 'joystick', 1.5, d);
  },

  update(ctx, dt) {
    const s = S(ctx);
    const P = ctx.params;
    syncGuards(ctx, s);
    const decay = (P.noiseDecayPerSec / P.noiseLimit) * dt;

    for (const g of s.guards) {
      const ent = ctx.world.get(g.id);
      if (!ent) continue;
      moveGuard(ctx, s, g, ent, dt);

      if (g.phase === 'calm') {
        const sight = visionOn(P, g);
        for (const p of ctx.players) {
          const e = ctx.entityOf(p.id);
          if (!e || isStunned(ctx as BlockCtx<unknown>, e)) continue;
          const sp = len(e.vx, e.vy);
          if (sp < FREEZE_SPEED) continue;
          const tip = s.tiptoe.get(p.id) ?? false;
          const prox = clamp(1 - len(e.x - ent.x, e.y - ent.y) / P.hearingRadius, 0, 1);
          let add = ((P.noisePerMove * loudness(s, p.id, e) * prox) / P.noiseLimit) * dt;
          if (sight && !tip && inCone(ent, g.facing, P, e)) add += SIGHT_RATE * dt;
          if (add <= 0) continue;
          g.level += add;
          g.contrib.set(p.id, (g.contrib.get(p.id) ?? 0) + add);
        }
        if (g.level >= 1) {
          wake(ctx, g, ent);
        } else {
          const before = g.level;
          g.level = Math.max(0, g.level - decay);
          const k = before > 0 ? g.level / before : 0;
          for (const [id, c] of g.contrib) g.contrib.set(id, c * k);
          const stir = g.level >= STIR_AT;
          if (stir && !g.stirring) {
            ctx.emit({ type: 'sneak.stir', data: { guard: ent.id } });
            ctx.fx({ kind: 'sfx', name: 'tick' });
            ctx.fx({ kind: 'particles', preset: 'smoke', x: ent.x, y: ent.y - ent.r });
          }
          g.stirring = stir;
        }
      } else if (P.onWake === 'chase') {
        if (g.phase === 'waking') {
          // wind-up: it turns to the culprit (telegraph), then the chase is on
          const ce = g.culprit ? ctx.entityOf(g.culprit) : undefined;
          if (ce) g.facing = Math.atan2(ce.y - ent.y, ce.x - ent.x);
          if (ctx.time >= g.wokeAt + WINDUP_SEC) {
            fullyAwake(ctx, s, g, ent);
            if (!g.target) g.phase = 'return';
          }
        } else if (g.phase === 'awake') {
          if (chase(ctx, g, ent, dt)) {
            g.phase = 'return';
            g.target = '';
          }
        } else if (walkHome(ctx, g, ent, dt)) {
          fallAsleep(ctx, g, ent);
        }
      } else {
        // live-safe: the end is derived from current params (a shorter wakeDurationSec ends it now)
        if (g.phase === 'waking' && ctx.time >= g.wokeAt + WINDUP_SEC) fullyAwake(ctx, s, g, ent);
        if (ctx.time >= g.wokeAt + WINDUP_SEC + P.wakeDurationSec || g.phase === 'return') {
          fallAsleep(ctx, g, ent);
        } else if (g.phase === 'awake') {
          for (const p of ctx.players) {
            const e = ctx.entityOf(p.id);
            if (!e || g.caught.has(p.id) || isStunned(ctx as BlockCtx<unknown>, e)) continue;
            if (len(e.vx, e.vy) < FREEZE_SPEED || !inCone(ent, g.facing, P, e)) continue;
            g.caught.add(p.id);
            const penalty = penalize(ctx, p.id, 'Caught!');
            e.props.stunUntil = ctx.time + CAUGHT_STUN_SEC;
            e.vx = e.vy = 0;
            ctx.emit({ type: 'sneak.caught', player: p.id, data: { guard: ent.id, penalty } });
            ctx.fx({ kind: 'shake', strength: 0.3 });
            ctx.fx({ kind: 'sfx', name: 'hit' });
            ctx.fx({ kind: 'particles', preset: 'burst', x: e.x, y: e.y });
          }
        }
      }
      publish(ctx, g, ent);
    }

    // how loud everyone is, for renderers (noise rings) and bots
    for (const p of ctx.players) {
      const e = ctx.entityOf(p.id);
      if (e) e.props.loud = clamp(loudness(s, p.id, e) / LOUD_FULL, 0, 1);
    }

    // daring: creeping close to a calm guard pays
    if (P.daringPoints > 0) {
      for (const p of ctx.players) {
        const e = ctx.entityOf(p.id);
        if (!e || len(e.vx, e.vy) < FREEZE_SPEED) continue;
        const near = s.guards.some((g) => {
          const ent = ctx.world.get(g.id);
          return ent && g.phase === 'calm' && len(e.x - ent.x, e.y - ent.y) <= P.hearingRadius * DARE_ZONE;
        });
        if (!near) continue;
        const t = (s.dare.get(p.id) ?? 0) + dt;
        if (t >= DARE_SEC) {
          s.dare.set(p.id, t - DARE_SEC);
          ctx.score(p.id, P.daringPoints, 'Daring!');
          ctx.fx({ kind: 'particles', preset: 'sparkle', x: e.x, y: e.y });
          ctx.fx({ kind: 'sfx', name: 'coin' });
        } else {
          s.dare.set(p.id, t);
        }
      }
    }

    fallbackMove(ctx as BlockCtx<unknown>, 'sneak', s.intents, dt);
  },

  onTimeline(ctx, ev: TimelineEvent) {
    // "bear-sleepwalk" style surprises: sleepers wander their patrol loop (still asleep)
    if (!/sleepwalk|wander|patrol/i.test(ev.kind)) return;
    const d = typeof ev.params.durationSec === 'number' ? ev.params.durationSec : 10;
    S(ctx).sleepwalkUntil = ctx.time + clamp(d, 1, 30);
  },

  bot(ctx, playerId, skill) {
    const s = S(ctx);
    const P = ctx.params;
    const e = ctx.entityOf(playerId);
    if (!e) return { t: 0 };
    const sk = clamp(skill, 0, 1);
    let m = s.bots.get(playerId);
    if (!m) {
      // nerve: how much noise this bot lets the guard build before creeping (personality)
      m = { ...botMem(new Map(), playerId), careless: false, nerve: ctx.rng.range(0.55, 0.95) };
      s.bots.set(playerId, m);
    }
    let nearest: { g: Guard; ent: Entity; d: number } | undefined;
    for (const g of s.guards) {
      const ent = ctx.world.get(g.id);
      if (!ent) continue;
      const d = len(e.x - ent.x, e.y - ent.y);
      if (!nearest || d < nearest.d) nearest = { g, ent, d };
    }
    if (!nearest) return { t: 0 };
    const { g, ent, d } = nearest;
    const key = P.tiptoeButton;

    if (P.onWake === 'chase') {
      // hunted: run for it (the carrying block steers; just never creep)
      if (g.phase !== 'calm' && g.culprit === playerId) {
        const ax = e.x - ent.x, ay = e.y - ent.y, l = len(ax, ay) || 1;
        return { t: 0, axes: { x: ax / l, y: ay / l }, buttons: { [key]: false } };
      }
      // a busy guard hears nothing: move freely
      if (g.phase !== 'calm') return { t: 0, buttons: { [key]: false } };
    } else if (g.phase !== 'calm' && d <= P.visionRange + 80 && !m.careless) {
      // a woken guard nearby: good bots freeze until it dozes off
      return { t: 0, axes: { x: 0, y: 0 }, buttons: { [key]: true } };
    }

    if (ctx.time >= m.until || len(m.tx - e.x, m.ty - e.y) < 30) {
      // wander inside the daring zone around the guard
      const a = ctx.rng.range(0, Math.PI * 2);
      const r = P.hearingRadius * DARE_ZONE * ctx.rng.range(0.5, 0.9);
      m.tx = clamp(ent.x + Math.cos(a) * r, 40, ctx.world.width - 40);
      m.ty = clamp(ent.y + Math.sin(a) * r, 40, ctx.world.height - 40);
      m.until = ctx.time + ctx.rng.range(1.5, 3);
      // sloppier bots sometimes forget to tiptoe for a stretch; in a chase game everyone
      // gets greedy now and then (that's what wakes the bear)
      m.careless = ctx.rng.next() < (1 - sk) * 0.5 + (P.onWake === 'chase' ? 0.2 : 0);
    }
    // creep when close and the guard is getting restless (loaded bots get nervous sooner);
    // careless bots only notice a stirring guard if they are good enough (weak ones never do)
    const carry = typeof e.props.carry === 'number' ? e.props.carry : 0;
    const close = d < P.hearingRadius * 0.85;
    const edgy = g.level > m.nerve - 0.08 * carry || (P.onWake === 'stare' && !m.careless);
    const tip = close && (m.careless ? g.level > 0.5 + 0.7 * (1 - sk) + (P.onWake === 'chase' ? 0.45 : 0) : edgy);
    return { t: 0, axes: steer(ctx as BlockCtx<unknown>, m, e, m.tx, m.ty, sk), buttons: { [key]: tip } };
  },
};
