import { z } from 'zod';
import type { BlockCtx, BlockDef } from '../block';
import type { Entity } from '../world';
import {
  type DashInfo, type OverloadState, type PaintState, type RingState, isOut, overloadBot, overloadCut, overloadSetup, overloadSpeed,
  overloadUpdate, paintBot, paintBurst, paintSetup, paintUpdate, ringBot, ringCrumbleNow, ringSetup, ringUpdate,
} from './arena-modes';
import { type CrateState, crateBot, crateRefillAll, crateSetup, crateUpdate } from './crate-mode';
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
  dashShove: z.number().min(1).max(4).describe('A dashing avatar hits others this many times harder (shove rivals into hazards: knockouts).'),
  shoveStunSec: z.number().min(0).max(2).describe("Seconds a dash-shoved victim can't steer (it slides). Teammates are never stunned."),
  callout: z.string().max(24).describe("Namespace for the headline events the TV calls out (<callout>.ringout, .crumble, .overload, .core.pass, .paint.tally); '' = off."),
  ringOut: z.boolean().describe('RING OUT mode: the arena is a round floating platform of floor tiles that crumbles inward ring by ring; anyone off the platform falls out and respawns in the centre.'),
  ringRadius: z.number().min(160).max(400).describe('RING OUT: platform radius at the start, px.'),
  ringTile: z.number().min(32).max(96).describe('RING OUT: floor tile size, px (one crumble ring is one tile wide).'),
  ringShrinkTo: z.number().min(60).max(400).describe('RING OUT: the platform crumbles (evenly from 30% of the round to 6 s before the end) down to about this radius, px.'),
  ringOutPoints: z.number().int().min(0).max(10).describe('RING OUT: points to the last player who touched a rival (within ringCreditSec) when that rival falls off.'),
  ringFallPenalty: z.number().int().min(0).max(5).describe('RING OUT: points lost for falling off (never below zero).'),
  ringSurvivePoints: z.number().int().min(0).max(5).describe('RING OUT: points to everyone still on the platform when a ring drops.'),
  ringComebackPoints: z.number().int().min(0).max(3).describe('RING OUT: comeback: a player in last place (behind everyone else) scores this when they respawn after a fall.'),
  ringCreditSec: z.number().min(0.5).max(5).describe('RING OUT: a touch this recent earns the ring-out credit.'),
  respawnSec: z.number().min(0.5).max(5).describe('RING OUT: seconds out after a fall before respawning in the centre.'),
  respawnInvulnSec: z.number().min(0).max(3).describe("RING OUT: after respawning, can't fall or be bumped for this long, s."),
  ringCrumbleEventKind: z.string().max(40).describe("RING OUT: timeline event kind (exact) that crumbles the next ring right away. '' = off."),
  overload: z.boolean().describe('OVERLOAD mode (hot potato): one player holds an unstable core; touching a rival passes it; when its hidden fuse runs out the holder loses overloadPenalty and everyone else gets overloadReward; then a new core goes to a random player.'),
  overloadCores: z.number().int().min(1).max(3).describe('OVERLOAD: cores live at once (at most one per two players: 4 players and 2 => two hot potatoes).'),
  overloadFuseMin: z.number().min(3).max(30).describe('OVERLOAD: shortest fuse, s (each core gets a random fuse between min and max; it pulses faster as it burns).'),
  overloadFuseMax: z.number().min(3).max(30).describe('OVERLOAD: longest fuse, s.'),
  overloadPenalty: z.number().int().min(0).max(10).describe('OVERLOAD: points the holder loses when the core detonates (never below zero).'),
  overloadReward: z.number().int().min(0).max(5).describe('OVERLOAD: points every other player gets on a detonation.'),
  overloadAssistPoints: z.number().int().min(0).max(5).describe('OVERLOAD: extra points, on a detonation, for whoever handed the core to the holder (on top of overloadReward).'),
  overloadClutchPoints: z.number().int().min(0).max(5).describe('OVERLOAD: points for passing the core while it is critical (its last 3 s): a clutch pass.'),
  overloadSafePoints: z.number().int().min(0).max(3).describe('OVERLOAD: every 5 s, everyone not holding a core gets this many points (holding costs you).'),
  overloadPassImmunitySec: z.number().min(0).max(3).describe("OVERLOAD: after passing the core you can't be given it back for this long, s."),
  overloadHolderSpeed: z.number().min(1).max(1.5).describe('OVERLOAD: top speed multiplier of the core holder (keeps the chase fair).'),
  overloadStunSec: z.number().min(0).max(3).describe('OVERLOAD: the holder is stunned this long by the detonation, s.'),
  overloadEventKind: z.string().max(40).describe("OVERLOAD: timeline event kind (exact) that burns the current fuse down to a few seconds. '' = off."),
  paint: z.boolean().describe('PAINT mode (territory): the floor is a tile grid; moving paints tiles in your team colour (own colour without teams); dashing paints a burst; tile share scores every paintEverySec and the final tally counts paintFinalMul times.'),
  paintCols: z.number().int().min(6).max(24).describe('PAINT: grid columns.'),
  paintRows: z.number().int().min(4).max(14).describe('PAINT: grid rows.'),
  paintEverySec: z.number().min(2).max(20).describe('PAINT: seconds between territory tallies.'),
  paintPoints: z.number().int().min(1).max(50).describe('PAINT: points a tally pays for owning the whole floor (split by tiles you painted).'),
  paintFinalMul: z.number().min(1).max(5).describe('PAINT: the final tally at the buzzer pays this many times more.'),
  paintBurst: z.number().int().min(0).max(3).describe('PAINT: a dash paints a square of (2b+1)² tiles around you (1 => 3×3).'),
  paintUnderdog: z.boolean().describe('PAINT: players on the team (or player) behind on score dash-splash one size bigger (3×3 => 5×5): a comeback rubber band.'),
  crates: z.boolean().describe('CRATE CRASH mode (turns physics on): every player owns a square platform zone stacked with physics crates. Knock rivals\' crates out of their zone (dash, bump, or a barrel blast from world.props) for crateKnockPoints; every crateTallySec you score crateStandPoints per crate still standing in your zone; the final tally pays crateFinalMul times.'),
  crateZoneSize: z.number().min(140).max(320).describe('CRATES: zone side length, px.'),
  cratesPerZone: z.number().int().min(1).max(9).describe('CRATES: crates stacked in each zone (players × this ≤ 36).'),
  crateSize: z.number().min(0.6).max(1.6).describe('CRATES: crate size multiplier (1 = 44 px box).'),
  crateKnockPoints: z.number().int().min(0).max(10).describe("CRATES: points for knocking a rival's crate out of its zone."),
  crateStandPoints: z.number().int().min(0).max(5).describe('CRATES: points per standing crate at each tally.'),
  crateTallySec: z.number().min(3).max(30).describe('CRATES: seconds between standing-crate tallies.'),
  crateFinalMul: z.number().min(1).max(5).describe('CRATES: the final tally at the buzzer pays this many times more.'),
  crateRefillEventKind: z.string().max(40).describe("CRATES: timeline event kind (exact) that refills every zone to full right away. '' = off."),
  crateRefillSec: z.number().min(0).max(30).describe('CRATES: every this many seconds each zone gets a lost crate back (the last-place zone gets two); 0 = never.'),
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
  ring?: RingState;
  ov?: OverloadState;
  paint?: PaintState;
  crates?: CrateState;
}

const states = new WeakMap<object, State>();
const S = (ctx: object) => stateOf<State>(states, ctx, () => ({ ps: new Map(), bots: new Map() }));

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

/** Out of play (fallen) or respawn-invulnerable in ring-out: no collisions. */
function ghost(ctx: BlockCtx<ArenaMoveParams>, e: Entity): boolean {
  return isOut(e) || (ctx.params.ringOut && typeof e.props.invulnUntil === 'number' && ctx.time < e.props.invulnUntil);
}

function collide(ctx: BlockCtx<ArenaMoveParams>): void {
  const ps = ctx.players;
  for (let i = 0; i < ps.length; i++) {
    const a = ctx.entityOf(ps[i]!.id);
    if (!a) continue;
    if (ghost(ctx, a)) continue;
    for (let j = i + 1; j < ps.length; j++) {
      const b = ctx.entityOf(ps[j]!.id);
      if (!b || ghost(ctx, b)) continue;
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
      const [hitter, victim] = aIn >= bIn ? [a, b] : [b, a];
      markRam(hitter, victim, ctx.time);
      // contact record on the one pushed (ring-out credit goes to the last pusher, not to a victim
      // whose attacker overshoots)
      if (hitter.owner !== undefined) {
        victim.props.touchedBy = hitter.owner;
        victim.props.touchedAt = ctx.time;
      }
      const mates = a.team !== undefined && a.team === b.team;
      const dashing = hitter.props.dashing === true;
      const phys = ctx.physics?.params;
      const imp = rel * (1 + (phys ? Math.min(1, phys.restitution) : BUMP_RESTITUTION)) / 2;
      // a dash shoves: the victim takes dashShove times the impulse (physics: × knockback)
      const vk = (dashing ? ctx.params.dashShove : 1) * (phys ? phys.knockback : 1);
      const sign = victim === b ? 1 : -1;
      victim.vx += sign * imp * vk * nx; victim.vy += sign * imp * vk * ny;
      hitter.vx -= sign * imp * nx; hitter.vy -= sign * imp * ny;
      if (phys?.spin) {
        // grazing bumps spin both bodies (tangential relative speed, opposite senses)
        const vt = (a.vx - b.vx) * -ny + (a.vy - b.vy) * nx;
        const w = clamp(vt / (a.r + b.r), -14, 14) * (0.5 + phys.friction);
        a.props.av = (typeof a.props.av === 'number' ? a.props.av : 0) + w;
        b.props.av = (typeof b.props.av === 'number' ? b.props.av : 0) + w;
      }
      if (phys) {
        const t = ctx.time, k = Math.min(2, (rel * vk) / 600);
        a.props.hitAt = t; b.props.hitAt = t;
        a.props.impulse = k; b.props.impulse = k;
      }
      if (dashing || rel > HARD_BUMP) {
        if (hitter.owner !== undefined) {
          victim.props.shovedBy = hitter.owner;
          victim.props.shovedAt = ctx.time;
        }
        if (dashing && ctx.params.dashShove > 1 && !mates) {
          victim.props.stunUntil = Math.max(typeof victim.props.stunUntil === 'number' ? victim.props.stunUntil : 0, ctx.time + ctx.params.shoveStunSec);
          ctx.emit({ type: 'arena.shove', player: hitter.owner, data: { victim: victim.owner } });
        }
      }
      if (rel > HARD_BUMP || dashing) {
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
    dashShove: 1,
    shoveStunSec: 0.3,
    callout: 'play',
    ringOut: false,
    ringRadius: 330,
    ringTile: 48,
    ringShrinkTo: 150,
    ringOutPoints: 3,
    ringFallPenalty: 1,
    ringSurvivePoints: 0,
    ringComebackPoints: 0,
    ringCreditSec: 2,
    respawnSec: 1.5,
    respawnInvulnSec: 1,
    ringCrumbleEventKind: '',
    overload: false,
    overloadCores: 1,
    overloadFuseMin: 7,
    overloadFuseMax: 13,
    overloadPenalty: 3,
    overloadReward: 1,
    overloadAssistPoints: 1,
    overloadClutchPoints: 1,
    overloadSafePoints: 0,
    overloadPassImmunitySec: 0.8,
    overloadHolderSpeed: 1.12,
    overloadStunSec: 1,
    overloadEventKind: '',
    paint: false,
    paintCols: 20,
    paintRows: 12,
    paintEverySec: 5,
    paintPoints: 10,
    paintFinalMul: 2,
    paintBurst: 1,
    paintUnderdog: false,
    crates: false,
    crateZoneSize: 220,
    cratesPerZone: 5,
    crateSize: 1,
    crateKnockPoints: 2,
    crateStandPoints: 1,
    crateTallySec: 10,
    crateFinalMul: 2,
    crateRefillSec: 6,
    crateRefillEventKind: '',
  },
  controls: ['joystick', 'tilt', 'button'],
  arenaKinds: ['topdown'],
  requiredControls: (p) => [{ kind: p.input, id: '', param: 'input' }],
  usesPhysics: (p) => p.crates,

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
    const s = S(ctx);
    if (ctx.params.paint) s.paint = paintSetup(ctx);
    if (ctx.params.ringOut) s.ring = ringSetup(ctx);
    if (ctx.params.overload) s.ov = overloadSetup(ctx);
    if (ctx.params.crates) s.crates = crateSetup(ctx);
  },

  onTimeline(ctx, ev) {
    const s = S(ctx);
    const P = ctx.params;
    if (s.ring && P.ringCrumbleEventKind !== '' && ev.kind === P.ringCrumbleEventKind) ringCrumbleNow(ctx, s.ring);
    if (s.ov && P.overloadEventKind !== '' && ev.kind === P.overloadEventKind) overloadCut(ctx, s.ov);
    if (s.crates && P.crateRefillEventKind !== '' && ev.kind === P.crateRefillEventKind) crateRefillAll(ctx, s.crates);
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
      if (isOut(e)) { p.dashQueued = false; e.vx = e.vy = 0; continue; }
      // publish limits for hazard fairness maths (base speed: comeback boosts only help)
      e.props.topSpeed = P.speed;
      e.props.accel = P.accel;
      e.props.dashKey = P.dashButton;
      const stunned = isStunned(ctx as BlockCtx<unknown>, e);
      const top = P.speed * boostOf(e) * speedMulOf(e) * overloadSpeed(ctx, s.ov, pl.id);

      if (p.dashQueued && !stunned && ctx.time >= p.dashReadyAt) {
        e.vx = p.face.x * top * P.dashPower;
        e.vy = p.face.y * top * P.dashPower;
        p.dashUntil = ctx.time + P.dashMs / 1000;
        p.dashReadyAt = ctx.time + P.dashCooldownSec;
        ctx.emit({ type: 'arena.dash', player: pl.id });
        if (s.paint) paintBurst(ctx, s.paint, pl.id, e.x, e.y);
        ctx.fx({ kind: 'particles', preset: 'smoke', x: e.x, y: e.y });
        ctx.fx({ kind: 'sfx', name: 'whoosh' });
      }
      p.dashQueued = false;
      e.props.dashing = ctx.time < p.dashUntil;
      e.props.dashReady = ctx.time >= p.dashReadyAt;

      if (!e.props.dashing) {
        const dir = stunned ? { x: 0, y: 0 } : p.dir;
        if (dir.x === 0 && dir.y === 0) {
          // physics: knocked / released avatars slide longer on low damping (floaty), shorter on high
          const damp = ctx.physics ? clamp(ctx.physics.params.linearDamping / 1.2, 0.15, 4) : 1;
          const k = Math.exp(-P.friction * damp * dt);
          e.vx *= k;
          e.vy *= k;
          if (Math.abs(e.vx) < 1 && Math.abs(e.vy) < 1) e.vx = e.vy = 0;
        } else {
          // accelerate toward the target velocity, capped at accel*dt per step
          const dvx = dir.x * top - e.vx, dvy = dir.y * top - e.vy;
          const dv = len(dvx, dvy), cap = (ctx.physics ? P.accel / Math.sqrt(ctx.physics.params.playerMass) : P.accel) * dt;
          const k = dv > cap ? cap / dv : 1;
          e.vx += dvx * k;
          e.vy += dvy * k;
        }
      }
    }

    if (P.collidePlayers) collide(ctx);
    if (s.ov) overloadUpdate(ctx, s.ov);
    if (s.paint) paintUpdate(ctx, s.paint, dt);
    if (s.crates) crateUpdate(ctx, s.crates, dt);

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
    // falls are judged on where avatars will be after this step's integration
    if (s.ring) ringUpdate(ctx, s.ring);
  },

  bot(ctx, playerId, skill) {
    const s = S(ctx);
    const e = ctx.entityOf(playerId);
    if (!e) return { t: 0 };
    const key0 = ctx.params.dashButton;
    const p0 = ps(s, playerId);
    const dash: DashInfo = { ready: ctx.time >= p0.dashReadyAt, face: p0.face };
    if (s.ring) return ringBot(ctx, s.ring, playerId, skill, dash, key0);
    if (s.paint) return paintBot(ctx, s.paint, playerId, skill, dash, key0);
    if (s.crates) return crateBot(ctx, s.crates, playerId, skill, dash, key0);
    if (s.ov) {
      const f = overloadBot(ctx, s.ov, playerId, skill, dash, key0);
      if (f) return f;
    }
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
    if (!key) return frame;
    // shove: a rival close ahead (along our motion) is worth a dash when dashes hit hard
    const sk = clamp(skill, 0, 1);
    let shove = false;
    const p = ps(s, playerId);
    if (ctx.params.dashShove > 1 && ctx.time >= p.dashReadyAt) {
      for (const o of ctx.players) {
        const oe = o.id === playerId ? undefined : ctx.entityOf(o.id);
        if (!oe) continue;
        const dx = oe.x - e.x, dy = oe.y - e.y, d = len(dx, dy);
        if (d > 150 || d < 1) continue;
        const ahead = (dx * p.face.x + dy * p.face.y) / d;
        if (ahead > 0.85 && ctx.rng.next() < 0.04 + 0.12 * sk) shove = true;
      }
    }
    // otherwise an occasional dash; better bots dash a little more deliberately
    frame.buttons = { [key]: shove || ctx.rng.next() < 0.004 + 0.01 * sk };
    return frame;
  },
};
