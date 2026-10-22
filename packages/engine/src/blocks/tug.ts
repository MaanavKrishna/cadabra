import { z } from 'zod';
import type { BlockCtx, BlockDef } from '../block';
import { AVATAR_R, clamp, pressed, stateOf } from './util';

export const tugSchema = z.object({
  mode: z.enum(['mash', 'rhythm', 'hold']).describe('mash: tap to pull. rhythm: taps on the beat pull hardest. hold: hold to pull while stamina lasts.'),
  ropeLength: z.number().min(200).max(1200).describe("Distance the knot travels from the centre line to either team's win line and back, px."),
  forcePerTap: z.number().min(5).max(200).describe('Rope speed one tap adds (px/s), averaged over the team so uneven teams are fair.'),
  fatigue: z.number().min(0).max(1).describe('Stamina lost per tap (mash/rhythm) or per second held (hold); 0 = tireless.'),
  rhythmBpm: z.number().min(40).max(200).describe('Beat tempo for rhythm mode, beats per minute.'),
  suddenDeathAtSec: z.number().min(5).max(120).describe('Sim second at which pulls get stronger (sudden death).'),
  pullButton: z.string().min(1).max(32).describe('Controller button / hold id used to pull (swipes also pull).'),
  winPoints: z.number().int().min(1).max(20).describe('Points to every member of a team that drags the knot over its line.'),
});
export type TugParams = z.infer<typeof tugSchema>;

interface Puller {
  stamina: number;
  buttons: Map<string, boolean>;
  taps: number;
  holding: boolean;
  lastTapAt: number;
  /** Rhythm mode: the beat this player already pulled on (one pull per beat). */
  lastCell: number;
}

interface TugBot {
  nextTapAt: number;
  down: boolean;
  resting: boolean;
  /** Hold mode: a low-skill lapse (let go) lasts until this time. */
  lapseUntil: number;
  nextLapseCheck: number;
}

interface State {
  /** Knot position as a fraction of the half rope: -1 = team 0's line, +1 = team 1's line. */
  pos: number;
  /** Knot velocity, fraction of the half rope per second. */
  vel: number;
  beat: number;
  pausedUntil: number;
  bouts: number;
  leadT: number;
  suddenDeath: boolean;
  ropeId?: number;
  pullers: Map<string, Puller>;
  bots: Map<string, TugBot>;
}

const states = new WeakMap<object, State>();
const S = (ctx: object) =>
  stateOf<State>(states, ctx, () => ({ pos: 0, vel: 0, beat: 0, pausedUntil: 0, bouts: 0, leadT: 0, suddenDeath: false, pullers: new Map(), bots: new Map() }));

const DRAG = 2.5; // per second
/** Stamina recovers toward 1 at this rate × the missing stamina, so faster tapping always pulls harder (with diminishing returns). */
const RECOVER_PER_SEC = 0.35;
const MIN_STAMINA = 0.15;
/** Hold mode: holding is worth this many taps per second. */
const HOLD_TAPS_PER_SEC = 10;
/** Hold mode drains fatigue × this per second held. */
const HOLD_DRAIN_MUL = 2.5;
/** Rhythm mode: a pull's strength falls from full (dead on the beat) to OFF_BEAT of it at this many seconds off. */
const BEAT_WINDOW = 0.15;
const OFF_BEAT = 0.1;
/** Rhythm mode: perfect on-beat pulling is worth this many taps per second at any bpm. */
const RHYTHM_TAPS_PER_SEC = 5;
/** Every this many seconds, the team holding the knot on its side scores LEAD_POINTS each. */
const LEAD_EVERY_SEC = 5;
const LEAD_ZONE = 0.15;
const LEAD_POINTS = 1;
const SUDDEN_MUL = 2;
const BOUT_PAUSE_SEC = 2;

function puller(s: State, id: string): Puller {
  let p = s.pullers.get(id);
  if (!p) {
    p = { stamina: 1, buttons: new Map(), taps: 0, holding: false, lastTapAt: -1, lastCell: -1 };
    s.pullers.set(id, p);
  }
  return p;
}

/** Distance to the nearest beat, seconds (beat phase is an accumulator, so bpm tweaks don't jump). */
function beatOffset(ctx: BlockCtx<TugParams>, s: State): number {
  const frac = s.beat - Math.floor(s.beat);
  return Math.min(frac, 1 - frac) * (60 / ctx.params.rhythmBpm);
}

function teamSizes(ctx: BlockCtx<TugParams>): [number, number] {
  const n: [number, number] = [0, 0];
  for (const p of ctx.players) if (p.team !== undefined && p.connected) n[p.team]++;
  return [Math.max(1, n[0]), Math.max(1, n[1])];
}

function layout(ctx: BlockCtx<TugParams>, s: State): void {
  const { width: w, height: h } = ctx.world;
  const half = ctx.params.ropeLength / 2;
  const kx = w / 2 + s.pos * half;
  const rope = s.ropeId !== undefined ? ctx.world.get(s.ropeId) : undefined;
  if (rope) {
    rope.x = kx;
    rope.y = h / 2;
    rope.props.pos = s.pos;
    rope.props.ropeLength = ctx.params.ropeLength;
    rope.props.lineLeft = w / 2 - half;
    rope.props.lineRight = w / 2 + half;
    rope.props.mode = ctx.params.mode;
    rope.props.beat = s.beat - Math.floor(s.beat);
    rope.props.onBeat = beatOffset(ctx, s) <= BEAT_WINDOW;
    rope.props.suddenDeath = s.suddenDeath;
    rope.props.paused = ctx.time < s.pausedUntil;
    rope.props.bouts = s.bouts;
  }
  // line the avatars up along the rope behind the knot, team 0 left, team 1 right
  const slot: [number, number] = [0, 0];
  for (const p of ctx.players) {
    const e = ctx.entityOf(p.id);
    if (!e || p.team === undefined) continue;
    const pu = puller(s, p.id);
    e.props.stamina = pu.stamina;
    e.props.pulling = pu.holding || ctx.time - pu.lastTapAt < 0.15;
    if (e.props.mover !== 'tug') continue;
    const k = slot[p.team]++;
    const dir = p.team === 0 ? -1 : 1;
    e.x = clamp(kx + dir * (90 + k * (e.r * 2 + 14)), e.r, w - e.r);
    e.y = h / 2 + (k % 2 ? 14 : -14);
    e.vx = e.vy = 0;
  }
}

export const tug: BlockDef<TugParams> = {
  id: 'tug',
  name: 'Tug of War',
  summary: 'Two teams haul a rope: mash, pull on the beat, or hold and manage stamina. Drag the knot over your line to win the bout.',
  paramsSchema: tugSchema,
  defaults: {
    mode: 'mash',
    ropeLength: 640,
    forcePerTap: 40,
    fatigue: 0.04,
    rhythmBpm: 100,
    suddenDeathAtSec: 50,
    pullButton: 'pull',
    winPoints: 3,
  },
  controls: ['button', 'hold', 'swipe'],
  arenaKinds: ['tug'],

  setup(ctx) {
    if (ctx.spec.teams !== 2) {
      throw new Error(`block tug requires teams: 2 (spec "${ctx.spec.id}" has teams: ${ctx.spec.teams})`);
    }
    const s = S(ctx);
    const { width: w, height: h } = ctx.world;
    s.ropeId = ctx.world.spawn('rope', w / 2, h / 2, { sprite: 'rope', r: 18, props: {} }).id;
    ctx.players.forEach((p, i) => {
      if (ctx.entityOf(p.id)) return;
      const opts: Parameters<typeof ctx.world.spawn>[3] = {
        owner: p.id, r: AVATAR_R, sprite: `avatar:${p.id}`, props: { mover: 'tug', boost: 1, topSpeed: 0, accel: 0 },
      };
      if (p.team !== undefined) opts.team = p.team;
      ctx.world.spawn('player', w / 2 + (p.team === 0 ? -1 : 1) * (100 + i * 10), h / 2, opts);
    });
    layout(ctx, s);
  },

  onInput(ctx, playerId, input) {
    const s = S(ctx);
    const P = ctx.params;
    const pu = puller(s, playerId);
    const down = input.buttons?.[P.pullButton] ?? false;
    const edge = pressed(pu.buttons, P.pullButton, down) || input.swipe !== undefined;
    pu.holding = P.mode === 'hold' && down;
    if (P.mode !== 'hold' && edge) pu.taps++;
  },

  update(ctx, dt) {
    const s = S(ctx);
    const P = ctx.params;
    s.beat += (dt * P.rhythmBpm) / 60;

    if (!s.suddenDeath && ctx.time >= P.suddenDeathAtSec) {
      s.suddenDeath = true;
      ctx.emit({ type: 'tug.suddenDeath' });
      ctx.fx({ kind: 'banner', text: 'Sudden death! Every pull counts double!' });
      ctx.fx({ kind: 'flash', color: '#ff3b30' });
      ctx.fx({ kind: 'sfx', name: 'whoosh' });
    }

    const half = P.ropeLength / 2;
    const paused = ctx.time < s.pausedUntil;
    const sizes = teamSizes(ctx);
    const force: [number, number] = [0, 0];
    const offset = beatOffset(ctx, s);
    for (const p of ctx.players) {
      const pu = puller(s, p.id);
      let pulls = 0;
      if (P.mode === 'hold') {
        if (pu.holding && pu.stamina > MIN_STAMINA) {
          pulls = HOLD_TAPS_PER_SEC * dt * pu.stamina;
          pu.stamina = Math.max(0, pu.stamina - P.fatigue * HOLD_DRAIN_MUL * dt);
        } else {
          pu.stamina += RECOVER_PER_SEC * (1 - pu.stamina) * dt;
        }
      } else {
        for (; pu.taps > 0; pu.taps--) {
          let mul = 1;
          if (P.mode === 'rhythm') {
            // one pull per beat, scaled by timing; extra taps on the same beat are wasted effort
            const cell = Math.round(s.beat);
            const acc = OFF_BEAT + (1 - OFF_BEAT) * clamp(1 - offset / BEAT_WINDOW, 0, 1);
            mul = cell === pu.lastCell ? 0 : acc * RHYTHM_TAPS_PER_SEC * (60 / P.rhythmBpm);
            pu.lastCell = cell;
          }
          pulls += mul * pu.stamina;
          pu.stamina = Math.max(MIN_STAMINA, pu.stamina - P.fatigue * pu.stamina);
          pu.lastTapAt = ctx.time;
        }
        pu.stamina += RECOVER_PER_SEC * (1 - pu.stamina) * dt;
      }
      if (paused || p.team === undefined || !p.connected) continue;
      force[p.team] += pulls;
    }

    if (paused) {
      s.vel = 0;
    } else {
      const mul = s.suddenDeath ? SUDDEN_MUL : 1;
      // team 0 pulls toward -1, team 1 toward +1; averaged per member so 2v3 is fair
      const impulse = (P.forcePerTap * mul * (force[1] / sizes[1] - force[0] / sizes[0])) / half;
      s.vel = s.vel * Math.exp(-DRAG * dt) + impulse;
      s.pos = clamp(s.pos + s.vel * dt, -1, 1);
      if (Math.abs(s.pos) >= 1) {
        const team = (s.pos < 0 ? 0 : 1) as 0 | 1;
        s.bouts++;
        for (const p of ctx.players) if (p.team === team) ctx.score(p.id, P.winPoints, 'tug.win');
        ctx.emit({ type: 'tug.won', data: { team, bout: s.bouts } });
        const rope = s.ropeId !== undefined ? ctx.world.get(s.ropeId) : undefined;
        ctx.fx({ kind: 'particles', preset: 'confetti', x: rope?.x ?? ctx.world.width / 2, y: ctx.world.height / 2 });
        ctx.fx({ kind: 'shake', strength: 0.5 });
        ctx.fx({ kind: 'sfx', name: 'win' });
        s.pos = 0;
        s.vel = 0;
        s.pausedUntil = ctx.time + BOUT_PAUSE_SEC;
      }
      // holding the knot on your side pays a trickle, so even a stalemate has a leader
      s.leadT += dt;
      if (s.leadT >= LEAD_EVERY_SEC) {
        s.leadT -= LEAD_EVERY_SEC;
        if (Math.abs(s.pos) >= LEAD_ZONE) {
          const team = (s.pos < 0 ? 0 : 1) as 0 | 1;
          for (const p of ctx.players) if (p.team === team) ctx.score(p.id, LEAD_POINTS, 'tug.lead');
          ctx.emit({ type: 'tug.lead', data: { team, pos: s.pos } });
          ctx.fx({ kind: 'sfx', name: 'coin' });
        }
      }
    }
    layout(ctx, s);
  },

  bot(ctx, playerId, skill) {
    const s = S(ctx);
    const P = ctx.params;
    const sk = clamp(skill, 0, 1);
    let b = s.bots.get(playerId);
    if (!b) {
      b = { nextTapAt: ctx.rng.range(0, 0.3), down: false, resting: false, lapseUntil: 0, nextLapseCheck: 0 };
      s.bots.set(playerId, b);
    }
    const key = P.pullButton;
    const pu = puller(s, playerId);
    if (P.mode === 'hold') {
      // pulse: hold until tired, rest until recovered; sloppier bots also lose focus and let go
      if (ctx.time >= b.nextLapseCheck) {
        b.nextLapseCheck = ctx.time + 0.5;
        if (ctx.rng.next() < (1 - sk) * 0.5) b.lapseUntil = ctx.time + 0.5;
      }
      // short pulses that keep stamina high pull hardest; weaker bots hold on until exhausted
      const lo = MIN_STAMINA + 0.45 * sk, hi = Math.min(0.95, lo + 0.2);
      if (!b.resting && pu.stamina < lo) b.resting = true;
      if (b.resting && pu.stamina > hi) b.resting = false;
      return { t: 0, buttons: { [key]: !b.resting && ctx.time >= b.lapseUntil } };
    }
    if (b.down) {
      b.down = false;
      return { t: 0, buttons: { [key]: false } };
    }
    if (ctx.time < b.nextTapAt) return { t: 0, buttons: { [key]: false } };
    b.down = true;
    if (P.mode === 'rhythm') {
      // aim for the next beat; timing error grows as skill drops
      const period = 60 / P.rhythmBpm;
      const toNext = (1 - (s.beat - Math.floor(s.beat))) * period;
      b.nextTapAt = ctx.time + toNext + ctx.rng.range(-1, 1) * (1 - sk) * 0.2 * period;
      if (b.nextTapAt <= ctx.time) b.nextTapAt += period;
    } else {
      const hz = 3 + 5 * sk;
      b.nextTapAt = ctx.time + (1 / hz) * ctx.rng.range(0.8, 1.2);
    }
    return { t: 0, buttons: { [key]: true } };
  },
};

