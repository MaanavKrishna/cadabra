import { z } from 'zod';
import type { BlockCtx, BlockDef } from '../block';
import { AVATAR_R, boostOf, callout, clamp, pressed, stateOf } from './util';

export const tugSchema = z.object({
  mode: z.enum(['mash', 'rhythm', 'hold', 'beat']).describe('mash: tap to pull. rhythm: one pull per beat, scaled by timing. hold: hold to pull while stamina lasts. beat: rhythm-mash, every tap pulls but taps on the beat pull beatBonus times harder.'),
  ropeLength: z.number().min(200).max(1200).describe("Distance the knot travels from the centre line to either team's win line and back, px."),
  forcePerTap: z.number().min(5).max(200).describe('Rope speed one tap adds (px/s), averaged over the team so uneven teams are fair.'),
  fatigue: z.number().min(0).max(1).describe('Stamina lost per tap (mash/rhythm) or per second held (hold); 0 = tireless.'),
  rhythmBpm: z.number().min(40).max(200).describe('Beat tempo for rhythm mode, beats per minute.'),
  suddenDeathAtSec: z.number().min(5).max(120).describe('Sim second at which pulls get stronger (sudden death).'),
  pullButton: z.string().min(1).max(32).describe('Controller button / hold id used to pull (swipes also pull).'),
  winPoints: z.number().int().min(1).max(20).describe('Points to every member of a team that drags the knot over its line.'),
  beatBonus: z.number().min(1).max(5).describe("beat mode: an on-beat tap pulls this many times harder than an off-beat one."),
  surgeCombo: z.number().int().min(0).max(16).describe('Beats in a row where every team member lands an on-beat tap that trigger a SURGE (a big yank toward that team); 0 = off. beat/rhythm modes.'),
  suddenDeathBpmMul: z.number().min(1).max(2).describe('At sudden death the beat speeds up by this factor (rhythm/beat modes).'),
  underdogBoost: z.number().min(0).max(2).describe('Rubber band: the team behind on points pulls up to (1 + underdogBoost) times harder, scaling with the gap (full at 2 bouts behind). 0 = off.'),
  callout: z.string().max(24).describe("Namespace for the headline events the TV calls out (<callout>.surge, .splash, .swing); '' = off."),
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
  /** Last beat this player hit on time (surge combos). */
  onBeatCell: number;
}

interface TugBot {
  nextTapAt: number;
  down: boolean;
  resting: boolean;
  /** Hold mode: a low-skill lapse (let go) lasts until this time. */
  lapseUntil: number;
  nextLapseCheck: number;
  /** beat mode personality: 0 = metronome, 1 = panic masher. */
  mash: number;
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
  /** Beats (cells) evaluated for surge combos so far. */
  judgedCell: number;
  combo: [number, number];
  surgeAt: number;
  surgeTeam: number;
  splashAt: number;
  splashTeam: number;
  ropeId?: number;
  pullers: Map<string, Puller>;
  bots: Map<string, TugBot>;
}

const states = new WeakMap<object, State>();
const S = (ctx: object) =>
  stateOf<State>(states, ctx, () => ({
    pos: 0, vel: 0, beat: 0, pausedUntil: 0, bouts: 0, leadT: 0, suddenDeath: false, judgedCell: -1, combo: [0, 0],
    surgeAt: -1, surgeTeam: -1, splashAt: -1, splashTeam: -1, pullers: new Map(), bots: new Map(),
  }));

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
/** beat mode: a tap within this many seconds of a beat is "on the beat" (tighter: mashing can't fake it). */
const BEAT_HIT = 0.1;
const hitWindow = (P: TugParams) => (P.mode === 'beat' ? BEAT_HIT : BEAT_WINDOW);
const OFF_BEAT = 0.1;
/** Rhythm mode: perfect on-beat pulling is worth this many taps per second at any bpm. */
const RHYTHM_TAPS_PER_SEC = 5;
/** Every this many seconds, the team holding the knot on its side scores LEAD_POINTS each. */
const LEAD_EVERY_SEC = 5;
const LEAD_ZONE = 0.15;
const LEAD_POINTS = 1;
const SUDDEN_MUL = 2;
const BOUT_PAUSE_SEC = 2;
/** A surge yanks the knot this fast toward the surging team (fraction of the half rope per second). */
const SURGE_KICK = 0.9;
/** Timeline kinds that make the knot lurch toward the team behind. */
export const TUG_SWING = /sneeze|swing|wobble|gust|lurch/i;
const SWING_KICK = 1.4;

function puller(s: State, id: string): Puller {
  let p = s.pullers.get(id);
  if (!p) {
    p = { stamina: 1, buttons: new Map(), taps: 0, holding: false, lastTapAt: -1, lastCell: -1, onBeatCell: -1 };
    s.pullers.set(id, p);
  }
  return p;
}

/** Distance to the nearest beat, seconds (beat phase is an accumulator, so bpm tweaks don't jump). */
function beatOffset(ctx: BlockCtx<TugParams>, s: State): number {
  const frac = s.beat - Math.floor(s.beat);
  return Math.min(frac, 1 - frac) * (60 / bpm(ctx, s));
}

/** Current tempo: rhythmBpm, sped up at sudden death. */
function bpm(ctx: BlockCtx<TugParams>, s: State): number {
  return ctx.params.rhythmBpm * (s.suddenDeath ? ctx.params.suddenDeathBpmMul : 1);
}

/** Judge finished beats for surge combos: a beat counts when every connected member hit it. */
function judgeBeats(ctx: BlockCtx<TugParams>, s: State): void {
  const P = ctx.params;
  const done = Math.floor(s.beat - 0.5); // beats whose timing window has closed
  for (; s.judgedCell < done; ) {
    const cell = ++s.judgedCell;
    if (P.surgeCombo <= 0 || (P.mode !== 'beat' && P.mode !== 'rhythm') || ctx.time < s.pausedUntil) continue;
    for (const team of [0, 1] as const) {
      const members = ctx.players.filter((p) => p.team === team && p.connected);
      const all = members.length > 0 && members.every((p) => puller(s, p.id).onBeatCell === cell);
      s.combo[team] = all ? s.combo[team] + 1 : 0;
      if (s.combo[team] < P.surgeCombo) continue;
      s.combo[team] = 0;
      s.vel += team === 0 ? -SURGE_KICK : SURGE_KICK;
      s.surgeAt = ctx.time;
      s.surgeTeam = team;
      callout(ctx as BlockCtx<unknown>, P.callout, 'surge', members[0]?.id, { team });
      ctx.fx({ kind: 'shake', strength: 0.35 });
      ctx.fx({ kind: 'sfx', name: 'whoosh' });
    }
  }
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
    rope.props.beatIndex = Math.floor(s.beat);
    rope.props.bpm = bpm(ctx, s);
    rope.props.onBeat = beatOffset(ctx, s) <= hitWindow(ctx.params);
    rope.props.combo0 = s.combo[0];
    rope.props.combo1 = s.combo[1];
    rope.props.surgeAt = s.surgeAt;
    rope.props.surgeTeam = s.surgeTeam;
    rope.props.splashAt = s.splashAt;
    rope.props.splashTeam = s.splashTeam;
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
    beatBonus: 2.5,
    surgeCombo: 0,
    suddenDeathBpmMul: 1,
    underdogBoost: 0,
    callout: 'tug',
  },
  controls: ['button', 'hold', 'swipe'],
  arenaKinds: ['tug'],
  requiredControls: (p) => [
    p.mode === 'hold'
      ? { kind: 'hold', id: p.pullButton, param: 'pullButton', alt: [{ kind: 'button', id: p.pullButton }] }
      : { kind: 'button', id: p.pullButton, param: 'pullButton', alt: [{ kind: 'hold', id: p.pullButton }, { kind: 'swipe', id: '' }] },
  ],

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
    s.beat += (dt * bpm(ctx, s)) / 60;

    if (!s.suddenDeath && ctx.time >= P.suddenDeathAtSec) {
      s.suddenDeath = true;
      ctx.emit({ type: 'tug.suddenDeath' });
      ctx.fx({ kind: 'banner', text: P.suddenDeathBpmMul > 1 ? 'Sudden death! Faster beat, double pulls!' : 'Sudden death! Every pull counts double!' });
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
          const cellNow = Math.round(s.beat);
          if (offset <= hitWindow(P)) pu.onBeatCell = cellNow;
          if (P.mode === 'beat') mul = offset <= BEAT_HIT ? P.beatBonus : 1;
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
      const e = ctx.entityOf(p.id);
      force[p.team] += pulls * (e ? boostOf(e) : 1);
    }

    if (P.underdogBoost > 0) {
      // the team behind on points digs in harder (full boost at two bouts behind)
      const tot: [number, number] = [0, 0];
      for (const p of ctx.players) if (p.team !== undefined) tot[p.team] += p.score / sizes[p.team];
      const gap = tot[0] - tot[1];
      const k = 1 + P.underdogBoost * clamp(Math.abs(gap) / (2 * P.winPoints), 0, 1);
      if (gap > 0) force[1] *= k;
      else if (gap < 0) force[0] *= k;
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
        for (const p of ctx.players) if (p.team === team) ctx.score(p.id, P.winPoints, 'Splashed them!');
        ctx.emit({ type: 'tug.won', data: { team, bout: s.bouts } });
        s.splashAt = ctx.time;
        s.splashTeam = 1 - team;
        callout(ctx as BlockCtx<unknown>, P.callout, 'splash', ctx.players.find((p) => p.team === 1 - team)?.id, { team: 1 - team, winners: team, bout: s.bouts });
        ctx.fx({ kind: 'particles', preset: 'splash', x: ctx.world.width / 2, y: ctx.world.height / 2 + 40 });
        s.combo = [0, 0];
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
          for (const p of ctx.players) if (p.team === team) ctx.score(p.id, LEAD_POINTS, 'Pull!');
          ctx.emit({ type: 'tug.lead', data: { team, pos: s.pos } });
          ctx.fx({ kind: 'sfx', name: 'coin' });
        }
      }
    }
    judgeBeats(ctx, s);
    layout(ctx, s);
  },

  onTimeline(ctx, ev) {
    // a comedy swing ('bear-sneeze', 'gust', 'wobble'...): the knot lurches toward the team
    // that is behind on points, so nobody is ever out of it
    if (!TUG_SWING.test(ev.kind)) return;
    const s = S(ctx);
    const tot: [number, number] = [0, 0];
    for (const p of ctx.players) if (p.team !== undefined) tot[p.team] += p.score;
    const team: 0 | 1 = tot[0] === tot[1] ? (s.pos > 0 ? 0 : 1) : tot[0] < tot[1] ? 0 : 1;
    s.vel += team === 0 ? -SWING_KICK : SWING_KICK;
    callout(ctx as BlockCtx<unknown>, ctx.params.callout, 'swing', ctx.players.find((p) => p.team === team)?.id, { team });
    ctx.fx({ kind: 'shake', strength: 0.4 });
  },

  bot(ctx, playerId, skill) {
    const s = S(ctx);
    const P = ctx.params;
    const sk = clamp(skill, 0, 1);
    let b = s.bots.get(playerId);
    if (!b) {
      b = { nextTapAt: ctx.rng.range(0, 0.3), down: false, resting: false, lapseUntil: 0, nextLapseCheck: 0, mash: ctx.rng.next() };
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
    if (P.mode === 'beat') {
      // rhythm-mash: tap between beats, but land a tap on every beat (timing error grows as
      // skill drops). Tired or calm bots only tap the beats; a losing panic-masher forgets the beat.
      const period = 60 / bpm(ctx, s);
      const frac = s.beat - Math.floor(s.beat);
      const toNext = (1 - frac) * period;
      const team = ctx.players.find((p) => p.id === playerId)?.team;
      const losing = team !== undefined && (team === 0 ? s.pos > 0.35 : s.pos < -0.35);
      const panic = losing && b.mash > 0.6;
      const hz = (2.5 + 4 * sk) * (0.8 + 0.5 * b.mash) * (panic ? 1.3 : 1);
      const err = ctx.rng.range(-1, 1) * (0.04 + (1 - sk) * 0.5) * period;
      const metronome = !panic && (pu.stamina < 0.35 + 0.25 * (1 - b.mash) || b.mash < 0.2);
      const mashNext = (1 / hz) * ctx.rng.range(0.85, 1.15);
      if (metronome || (!panic && toNext < mashNext + 0.05)) b.nextTapAt = ctx.time + toNext + err;
      else b.nextTapAt = ctx.time + mashNext;
      if (b.nextTapAt <= ctx.time + 2 / 60) b.nextTapAt += period;
    } else if (P.mode === 'rhythm') {
      // aim for the next beat; timing error grows as skill drops
      const period = 60 / bpm(ctx, s);
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

