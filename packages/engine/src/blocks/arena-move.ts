import { z } from 'zod';
import type { BlockCtx, BlockDef } from '../block';
import {
  AVATAR_R, type BotMem, type Vec, boostOf, botMem, clamp, ensureAvatars, inputDir, isStunned, keepInArena, len,
  markRam, pressed, speedMulOf, stateOf, steer,
} from './util';

export const arenaMoveSchema = z.object({
  speed: z.number().min(60).max(600).describe('Top speed in px/s.'),
  accel: z.number().min(200).max(8000).describe('How fast velocity reaches the stick direction, px/s².'),
  friction: z.number().min(0).max(20).describe('Velocity decay per second when the stick is released (0 = ice, 20 = instant stop).'),
  bounceWalls: z.boolean().describe('Walls bounce (true) or stop (false) avatars.'),
  collidePlayers: z.boolean().describe('Avatars push each other apart (needed for bump/steal mechanics).'),
  dashButton: z.string().max(32).describe("Controller button id that dashes; '' disables dashing."),
  dashCooldownSec: z.number().min(0.2).max(10).describe('Seconds between dashes.'),
  dashPower: z.number().min(1.2).max(4).describe('Dash speed as a multiple of `speed`.'),
  dashMs: z.number().min(80).max(600).describe('Dash duration, ms.'),
  input: z.enum(['joystick', 'tilt']).describe('Steering source: phone joystick or phone tilt.'),
  tiltSensitivity: z.number().min(0.5).max(4).describe('Tilt gain: phones are rarely tilted fully, so a modest tilt reaches top speed.'),
  avatarScale: z.number().min(0.5).max(2.5).describe('Avatar size multiplier (bigger = easier to bump, harder to dodge).'),
});
export type ArenaMoveParams = z.infer<typeof arenaMoveSchema>;

interface PlayerState {
  dir: Vec;
  /** Last non-zero direction: dashes go this way. */
  face: Vec;
  buttons: Map<string, boolean>;
  dashQueued: boolean;
  dashReadyAt: number;
  dashUntil: number;
}

interface State {
  ps: Map<string, PlayerState>;
  bots: Map<string, BotMem>;
}

const states = new WeakMap<object, State>();
const S = (ctx: object) => stateOf(states, ctx, () => ({ ps: new Map(), bots: new Map() }));

function ps(s: State, id: string): PlayerState {
  let p = s.ps.get(id);
  if (!p) {
    p = { dir: { x: 0, y: 0 }, face: { x: 1, y: 0 }, buttons: new Map(), dashQueued: false, dashReadyAt: 0, dashUntil: 0 };
    s.ps.set(id, p);
  }
  return p;
}

const BUMP_RESTITUTION = 0.6;
const HARD_BUMP = 380;

function collide(ctx: BlockCtx<ArenaMoveParams>): void {
  const ps = ctx.players;
  for (let i = 0; i < ps.length; i++) {
    const a = ctx.entityOf(ps[i]!.id);
    if (!a) continue;
    for (let j = i + 1; j < ps.length; j++) {
      const b = ctx.entityOf(ps[j]!.id);
      if (!b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = len(dx, dy), min = a.r + b.r;
      if (d >= min) continue;
      // deterministic normal even when perfectly stacked
      const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
      const push = (min - d) / 2;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;
      const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (rel <= 0) continue; // already separating
      // record who rammed whom before the impulse swaps velocities (collect's steal reads it)
      const aIn = a.vx * nx + a.vy * ny, bIn = -(b.vx * nx + b.vy * ny);
      if (aIn >= bIn) markRam(a, b, ctx.time);
      else markRam(b, a, ctx.time);
      const imp = rel * (1 + BUMP_RESTITUTION) / 2;
      a.vx -= imp * nx; a.vy -= imp * ny;
      b.vx += imp * nx; b.vy += imp * ny;
      if (rel > HARD_BUMP) {
        ctx.fx({ kind: 'particles', preset: 'burst', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        ctx.fx({ kind: 'shake', strength: 0.15 });
        ctx.fx({ kind: 'sfx', name: 'hit' });
      }
    }
  }
}

export const arenaMove: BlockDef<ArenaMoveParams> = {
  id: 'arena-move',
  name: 'Arena Move',
  summary: 'Top-down movement: one avatar per player, joystick or tilt steering, dash, wall bounce and body bumps.',
  paramsSchema: arenaMoveSchema,
  defaults: {
    speed: 260,
    accel: 1800,
    friction: 8,
    bounceWalls: true,
    collidePlayers: true,
    dashButton: 'dash',
    dashCooldownSec: 1.5,
    dashPower: 2.4,
    dashMs: 180,
    input: 'joystick',
    tiltSensitivity: 1.5,
    avatarScale: 1,
  },
  controls: ['joystick', 'tilt', 'button'],
  arenaKinds: ['topdown'],
  requiredControls: (p) => [{ kind: p.input, id: '', param: 'input' }],

  setup(ctx) {
    ensureAvatars(ctx as BlockCtx<unknown>, 'arena-move', AVATAR_R * ctx.params.avatarScale);
    // arena-move owns movement of every avatar, whichever block spawned it
    for (const p of ctx.players) {
      const e = ctx.entityOf(p.id);
      if (!e) continue;
      e.props.mover = 'arena-move';
      e.props.topSpeed = ctx.params.speed;
      e.props.accel = ctx.params.accel;
      e.props.dashKey = ctx.params.dashButton;
      e.r = AVATAR_R * ctx.params.avatarScale;
    }
  },

  onInput(ctx, playerId, input) {
    const p = ps(S(ctx), playerId);
    inputDir(input, ctx.params.input, ctx.params.tiltSensitivity, p.dir);
    if (p.dir.x !== 0 || p.dir.y !== 0) {
      const l = len(p.dir.x, p.dir.y);
      p.face.x = p.dir.x / l;
      p.face.y = p.dir.y / l;
    }
    const key = ctx.params.dashButton;
    if (key && pressed(p.buttons, key, input.buttons?.[key] ?? false)) p.dashQueued = true;
  },

  update(ctx, dt) {
    const s = S(ctx);
    const P = ctx.params;
    const { width: w, height: h } = ctx.world;
    const r = AVATAR_R * P.avatarScale;
    for (const pl of ctx.players) {
      const e = ctx.entityOf(pl.id);
      if (!e || e.props.mover !== 'arena-move') continue;
      const p = ps(s, pl.id);
      e.r = r;
      // publish limits for hazard fairness maths (base speed: comeback boosts only help)
      e.props.topSpeed = P.speed;
      e.props.accel = P.accel;
      e.props.dashKey = P.dashButton;
      const stunned = isStunned(ctx as BlockCtx<unknown>, e);
      const top = P.speed * boostOf(e) * speedMulOf(e);

      if (p.dashQueued && !stunned && ctx.time >= p.dashReadyAt) {
        e.vx = p.face.x * top * P.dashPower;
        e.vy = p.face.y * top * P.dashPower;
        p.dashUntil = ctx.time + P.dashMs / 1000;
        p.dashReadyAt = ctx.time + P.dashCooldownSec;
        ctx.emit({ type: 'arena.dash', player: pl.id });
        ctx.fx({ kind: 'particles', preset: 'smoke', x: e.x, y: e.y });
        ctx.fx({ kind: 'sfx', name: 'whoosh' });
      }
      p.dashQueued = false;
      e.props.dashing = ctx.time < p.dashUntil;
      e.props.dashReady = ctx.time >= p.dashReadyAt;

      if (!e.props.dashing) {
        const dir = stunned ? { x: 0, y: 0 } : p.dir;
        if (dir.x === 0 && dir.y === 0) {
          const k = Math.exp(-P.friction * dt);
          e.vx *= k;
          e.vy *= k;
          if (Math.abs(e.vx) < 1 && Math.abs(e.vy) < 1) e.vx = e.vy = 0;
        } else {
          // accelerate toward the target velocity, capped at accel*dt per step
          const dvx = dir.x * top - e.vx, dvy = dir.y * top - e.vy;
          const dv = len(dvx, dvy), cap = P.accel * dt;
          const k = dv > cap ? cap / dv : 1;
          e.vx += dvx * k;
          e.vy += dvy * k;
        }
      }
    }

    if (P.collidePlayers) collide(ctx);

    const bounce = P.bounceWalls ? 0.7 : 0;
    for (const pl of ctx.players) {
      const e = ctx.entityOf(pl.id);
      if (!e || e.props.mover !== 'arena-move') continue;
      keepInArena(e, w, h, bounce);
      // pre-clamp the integration that follows so the avatar never leaves the arena
      const nx = e.x + e.vx * dt, ny = e.y + e.vy * dt;
      if (nx < e.r || nx > w - e.r) e.vx = P.bounceWalls ? -e.vx * bounce : 0;
      if (ny < e.r || ny > h - e.r) e.vy = P.bounceWalls ? -e.vy * bounce : 0;
    }
  },

  bot(ctx, playerId, skill) {
    const s = S(ctx);
    const e = ctx.entityOf(playerId);
    if (!e) return { t: 0 };
    const m = botMem(s.bots, playerId);
    const { width: w, height: h } = ctx.world;
    // wander between random points; other blocks' bots override axes with real goals
    if (ctx.time >= m.until || len(m.tx - e.x, m.ty - e.y) < 30) {
      m.tx = ctx.rng.range(w * 0.15, w * 0.85);
      m.ty = ctx.rng.range(h * 0.15, h * 0.85);
      m.until = ctx.time + ctx.rng.range(1.5, 4);
    }
    const axes = steer(ctx as BlockCtx<unknown>, m, e, m.tx, m.ty, skill);
    const key = ctx.params.dashButton;
    const frame: { t: number; axes: Vec; buttons?: Record<string, boolean> } = { t: 0, axes };
    // occasional dash; better bots dash a little more deliberately
    if (key) frame.buttons = { [key]: ctx.rng.next() < 0.004 + 0.01 * clamp(skill, 0, 1) };
    return frame;
  },
};
