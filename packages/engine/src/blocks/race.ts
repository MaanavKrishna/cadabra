import { z } from 'zod';
import type { InputFrame } from '@cadabra/spec';
import type { BlockCtx, BlockDef, RequiredControl } from '../block';
import type { Entity } from '../world';
import { AVATAR_R, boostOf, clamp, isStunned, pressed, stateOf } from './util';

export const raceSchema = z.object({
  laneCount: z.number().int().min(1).max(8).describe('Lanes drawn on screen; players share lanes round-robin when there are more players.'),
  trackLength: z.number().min(1000).max(20000).describe('Length of one lap in track units (px of running at speed 1).'),
  laps: z.number().int().min(1).max(10).describe('Laps per heat.'),
  checkpointCount: z.number().int().min(0).max(10).describe('Scoring gates per lap (each worth checkpointPoints).'),
  checkpointPoints: z.number().int().min(0).max(10).describe('Points per checkpoint passed.'),
  relay: z.boolean().describe('Each lap is two legs: runner 1 must hand the baton to runner 2 in the handoff zone.'),
  batonPassButton: z.string().min(1).max(32).describe('Controller button id that hands over the baton (relay).'),
  obstacleDensity: z.number().min(0).max(1).describe('Obstacles per lap = round(obstacleDensity * 10); identical layout in every lane.'),
  boostPads: z.number().int().min(0).max(6).describe('Speed pads per lap (same positions in every lane).'),
  mashToRun: z.boolean().describe('true: tap runButton (or swipe right) to run; false: hold runButton / push the stick right.'),
  runButton: z.string().min(1).max(32).describe('Controller button id used to run (tap or hold, see mashToRun).'),
  jumpButton: z.string().min(1).max(32).describe('Controller button id that jumps obstacles (swipe up also jumps).'),
  runSpeed: z.number().min(80).max(900).describe('Top running speed, track units per second.'),
  mashPower: z.number().min(0.05).max(0.5).describe('Speed gained per tap as a fraction of runSpeed (mash mode).'),
  stumbleSec: z.number().min(0.2).max(3).describe('Seconds a runner stumbles after hitting an obstacle.'),
  padBoost: z.number().min(1.1).max(3).describe('Speed multiplier from a speed pad.'),
  padBoostSec: z.number().min(0.3).max(5).describe('How long a speed pad boost lasts, s.'),
});
export type RaceParams = z.infer<typeof raceSchema>;

interface Runner {
  progress: number;
  speed: number;
  lap: number;
  leg: 1 | 2;
  nextCp: number;
  finished: boolean;
  jumpUntil: number;
  padUntil: number;
  taps: number;
  run: boolean;
  jumpQueued: boolean;
  passQueued: boolean;
  buttons: Map<string, boolean>;
  mate?: number;
  baton?: number;
}

interface Feature {
  at: number; // fraction of a lap
  kind: 'obstacle' | 'boost-pad';
}

interface RaceBot {
  tapPhase: number;
  /** obstacle key (lap*100+index) -> will this bot clear it? decided once, by skill */
  willJump: Map<number, boolean>;
  inZoneSince?: number;
}

/** Params the current geometry was built from; live tweaks are diffed against these. */
interface Built {
  laneCount: number;
  obstacleDensity: number;
  boostPads: number;
  relay: boolean;
  trackLength: number;
  checkpointCount: number;
}

interface State {
  runners: Map<string, Runner>;
  layout: Feature[];
  featureIds: number[];
  built?: Built;
  lapsDone: Map<number, number>; // lap index -> finishers
  finishers: number;
  heatResetAt?: number;
  bots: Map<string, RaceBot>;
}

const states = new WeakMap<object, State>();
const S = (ctx: object) =>
  stateOf<State>(states, ctx, () => ({ runners: new Map(), layout: [], featureIds: [], lapsDone: new Map(), finishers: 0, bots: new Map() }));

const START_PAD = 80;
const END_PAD = 60;
const ACCEL = 900; // hold mode, track units / s²
const MASH_DECAY = 1.4; // per second
const JUMP_SEC = 0.55;
const HANDOFF_ZONE = 0.08; // fraction of a lap before the handoff
const LAP_POINTS = 3;
const LAP_LEAD_POINTS = 2;
const FINISH_POINTS = [8, 5, 3, 2, 1, 1, 1, 1];
const HEAT_GAP_SEC = 3;

function laneOf(ctx: BlockCtx<RaceParams>, idx: number): number {
  return idx % ctx.params.laneCount;
}

function laneY(ctx: BlockCtx<RaceParams>, lane: number): number {
  const lh = ctx.world.height / ctx.params.laneCount;
  return lh * (lane + 0.5);
}

/** Screen x for a lap fraction. */
function xAt(ctx: BlockCtx<RaceParams>, frac: number): number {
  return START_PAD + clamp(frac, 0, 1) * (ctx.world.width - START_PAD - END_PAD);
}

function handoff(P: RaceParams): number {
  return P.trackLength / 2;
}

function runnerR(ctx: BlockCtx<RaceParams>): number {
  return Math.min(AVATAR_R, (ctx.world.height / ctx.params.laneCount) * 0.35);
}

/** (Re)build the shared obstacle/pad layout and its entities in every lane. */
function buildLayout(ctx: BlockCtx<RaceParams>, s: State): void {
  const P = ctx.params;
  for (const id of s.featureIds) ctx.world.remove(id);
  s.featureIds = [];
  const feats: Feature[] = [];
  const nObs = Math.round(P.obstacleDensity * 10);
  const slots = nObs + P.boostPads;
  // evenly spaced slots with jitter, shuffled between obstacle/pad; one layout for all lanes (fair)
  const kinds: Feature['kind'][] = [...Array(nObs).fill('obstacle'), ...Array(P.boostPads).fill('boost-pad')];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = ctx.rng.int(0, i);
    [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!];
  }
  const span = 0.84;
  for (let i = 0; i < slots; i++) {
    const at = 0.1 + ((i + 0.5) / slots) * span + ctx.rng.range(-0.3, 0.3) * (span / slots);
    // keep the relay handoff zone clear
    const hz = 0.5 - HANDOFF_ZONE;
    const safeAt = P.relay && at > hz - 0.03 && at < 0.53 ? hz - 0.04 : at;
    feats.push({ at: safeAt, kind: kinds[i]! });
  }
  s.layout = feats.sort((a, b) => a.at - b.at);
  // every lane gets the same features so the track reads as one course
  for (let lane = 0; lane < P.laneCount; lane++) {
    for (const f of s.layout) {
      const e = ctx.world.spawn(f.kind, xAt(ctx, f.at), laneY(ctx, lane), {
        sprite: f.kind, r: f.kind === 'obstacle' ? 18 : 22, props: { lane, at: f.at },
      });
      s.featureIds.push(e.id);
    }
  }
  s.built = {
    laneCount: P.laneCount, obstacleDensity: P.obstacleDensity, boostPads: P.boostPads, relay: P.relay,
    trackLength: s.built?.trackLength ?? P.trackLength, checkpointCount: s.built?.checkpointCount ?? P.checkpointCount,
  };
}

/** Spawn or remove each runner's relay teammate and baton to match params.relay. */
function syncRelay(ctx: BlockCtx<RaceParams>, s: State): void {
  const P = ctx.params;
  const r0 = runnerR(ctx);
  for (const [id, r] of s.runners) {
    if (P.relay && r.mate === undefined) {
      r.mate = ctx.world.spawn('runner', 0, 0, { owner: id, r: r0 * 0.9, sprite: `avatar:${id}` }).id;
      r.baton = ctx.world.spawn('baton', 0, 0, { owner: id, r: 6, sprite: 'baton' }).id;
      // a runner already past the handoff carries on as runner 2 (never pulled backwards)
      r.leg = r.progress >= handoff(P) ? 2 : 1;
    } else if (!P.relay && r.mate !== undefined) {
      ctx.world.remove(r.mate);
      if (r.baton !== undefined) ctx.world.remove(r.baton);
      r.mate = r.baton = undefined;
      r.leg = 1;
    }
  }
}

/**
 * Apply Tweak-panel changes safely: rescale progress when the lap length changes (never
 * awarding laps or checkpoints), recount passed checkpoints, and rebuild lane geometry.
 */
function syncLive(ctx: BlockCtx<RaceParams>, s: State): void {
  const P = ctx.params;
  const b = s.built!;
  if (P.trackLength !== b.trackLength) {
    const k = P.trackLength / b.trackLength;
    for (const r of s.runners.values()) {
      r.progress = r.finished ? P.trackLength : Math.min(r.progress * k, P.trackLength - 1e-6);
    }
    b.trackLength = P.trackLength;
  }
  if (P.checkpointCount !== b.checkpointCount) {
    for (const r of s.runners.values()) {
      r.nextCp = Math.min(P.checkpointCount, Math.floor((r.progress / P.trackLength) * (P.checkpointCount + 1)));
    }
    b.checkpointCount = P.checkpointCount;
  }
  if (P.laneCount !== b.laneCount || P.obstacleDensity !== b.obstacleDensity || P.boostPads !== b.boostPads || P.relay !== b.relay) {
    buildLayout(ctx, s);
    syncRelay(ctx, s);
    const rr = runnerR(ctx);
    ctx.players.forEach((p, i) => {
      const e = ctx.entityOf(p.id);
      if (e && e.props.mover === 'race') {
        e.r = rr;
        e.props.lane = laneOf(ctx, i);
      }
      const m = s.runners.get(p.id)?.mate;
      if (m !== undefined) ctx.world.get(m)!.r = rr * 0.9;
    });
  }
}

function placeRunner(ctx: BlockCtx<RaceParams>, e: Entity, r: Runner, lane: number): void {
  const P = ctx.params;
  e.x = xAt(ctx, r.progress / P.trackLength);
  e.y = laneY(ctx, lane);
  e.props.lane = lane;
  e.vx = e.vy = 0;
  e.props.progress = r.progress;
  e.props.lap = r.lap;
  e.props.leg = r.leg;
  e.props.speed = r.speed;
  e.props.finished = r.finished;
  e.props.jump = r.jumpUntil > ctx.time ? 1 - (r.jumpUntil - ctx.time) / JUMP_SEC : 0;
  if (r.mate !== undefined) {
    const m = ctx.world.get(r.mate);
    if (m) {
      // the waiting runner stands at the handoff; after the pass the spent one rests there
      m.x = xAt(ctx, handoff(P) / P.trackLength);
      m.y = laneY(ctx, lane) + 0.3 * (ctx.world.height / P.laneCount) * 0.5;
      m.props.leg = r.leg === 1 ? 2 : 1;
      m.props.lane = lane;
    }
  }
  if (r.baton !== undefined) {
    const b = ctx.world.get(r.baton);
    if (b) { b.x = e.x + e.r * 0.6; b.y = e.y - e.r * 0.4; }
  }
}

function award(ctx: BlockCtx<RaceParams>, id: string, pts: number, reason: string, x: number, y: number, preset: 'sparkle' | 'confetti' | 'burst', sfx: string): void {
  if (pts > 0) ctx.score(id, pts, reason);
  ctx.fx({ kind: 'particles', preset, x, y });
  ctx.fx({ kind: 'sfx', name: sfx });
}

function advance(ctx: BlockCtx<RaceParams>, s: State, id: string, e: Entity, r: Runner, dt: number): void {
  const P = ctx.params;
  const t = ctx.time;
  const stunned = isStunned(ctx as BlockCtx<unknown>, e);
  const cap = P.runSpeed * boostOf(e) * (t < r.padUntil ? P.padBoost : 1);

  if (r.jumpQueued && t >= r.jumpUntil && !stunned) {
    r.jumpUntil = t + JUMP_SEC;
    ctx.fx({ kind: 'sfx', name: 'whoosh' });
  }
  r.jumpQueued = false;

  if (stunned) {
    r.speed = 0;
  } else if (P.mashToRun) {
    r.speed = r.speed * Math.exp(-MASH_DECAY * dt) + r.taps * P.runSpeed * P.mashPower;
    r.speed = Math.min(r.speed, cap);
  } else {
    r.speed = r.run ? Math.min(cap, r.speed + ACCEL * dt) : Math.max(0, r.speed - ACCEL * 1.5 * dt);
  }
  r.taps = 0;

  // relay: runner 1 waits at the handoff until the baton is passed
  const ho = handoff(P);
  if (P.relay && r.leg === 1) {
    const inZone = r.progress >= ho - P.trackLength * HANDOFF_ZONE;
    if (r.passQueued && inZone) {
      r.leg = 2;
      r.progress = Math.max(r.progress, ho);
      r.speed = Math.max(r.speed, P.runSpeed * 0.6); // the fresh runner gets a flying start
      ctx.emit({ type: 'race.batonPass', player: id, data: { lap: r.lap + 1 } });
      award(ctx, id, 0, 'race.batonPass', e.x, e.y, 'sparkle', 'pass');
    }
  }
  r.passQueued = false;

  const before = r.progress;
  let after = before + r.speed * dt;
  if (P.relay && r.leg === 1 && after > ho) {
    after = ho;
    r.speed = 0;
  }

  // obstacles and pads crossed this step (same layout every lane)
  for (const f of s.layout) {
    const at = f.at * P.trackLength;
    if (!(before < at && after >= at)) continue;
    if (f.kind === 'boost-pad') {
      r.padUntil = t + P.padBoostSec;
      ctx.fx({ kind: 'particles', preset: 'sparkle', x: e.x, y: e.y });
      ctx.fx({ kind: 'sfx', name: 'whoosh' });
    } else if (t >= r.jumpUntil) {
      after = at;
      r.speed = 0;
      e.props.stunUntil = t + P.stumbleSec;
      ctx.emit({ type: 'race.stumble', player: id });
      ctx.fx({ kind: 'particles', preset: 'smoke', x: e.x, y: e.y });
      ctx.fx({ kind: 'shake', strength: 0.25 });
      ctx.fx({ kind: 'sfx', name: 'hit' });
      break;
    }
  }

  // checkpoints
  while (r.nextCp < P.checkpointCount && after >= ((r.nextCp + 1) / (P.checkpointCount + 1)) * P.trackLength) {
    r.nextCp++;
    award(ctx, id, P.checkpointPoints, 'race.checkpoint', e.x, e.y, 'sparkle', 'tick');
  }
  r.progress = after;

  if (r.progress >= P.trackLength) lapDone(ctx, s, id, e, r);
}

function lapDone(ctx: BlockCtx<RaceParams>, s: State, id: string, e: Entity, r: Runner): void {
  const P = ctx.params;
  const lap = r.lap;
  const place = (s.lapsDone.get(lap) ?? 0) + 1;
  s.lapsDone.set(lap, place);
  r.lap++;
  r.nextCp = 0;
  r.leg = 1;
  award(ctx, id, LAP_POINTS, 'race.lap', e.x, e.y, 'burst', 'score');
  if (place === 1) {
    ctx.emit({ type: 'race.lapLead', player: id, data: { lap: lap + 1 } });
    award(ctx, id, LAP_LEAD_POINTS, 'race.lapLead', e.x, e.y, 'confetti', 'coin');
  }
  if (r.lap >= P.laps) {
    s.finishers++;
    r.finished = true;
    r.speed = 0;
    r.progress = P.trackLength;
    const pts = FINISH_POINTS[s.finishers - 1] ?? 1;
    ctx.emit({ type: 'race.finish', player: id, data: { place: s.finishers } });
    award(ctx, id, pts, 'race.finish', e.x, e.y, 'confetti', s.finishers === 1 ? 'win' : 'score');
    if (s.finishers === 1) ctx.fx({ kind: 'flash', color: '#ffffff' });
  } else {
    r.progress -= P.trackLength;
  }
}

function newHeat(ctx: BlockCtx<RaceParams>, s: State): void {
  for (const r of s.runners.values()) {
    Object.assign(r, { progress: 0, speed: 0, lap: 0, leg: 1, nextCp: 0, finished: false, jumpUntil: 0, padUntil: 0 });
  }
  s.lapsDone.clear();
  s.finishers = 0;
  s.heatResetAt = undefined;
  ctx.emit({ type: 'race.heat' });
  ctx.fx({ kind: 'sfx', name: 'wake' });
}

export const race: BlockDef<RaceParams> = {
  id: 'race',
  name: 'Race',
  summary: 'Lane race: mash or hold to run, jump obstacles, hit speed pads, optional relay with baton passes; heats repeat.',
  paramsSchema: raceSchema,
  defaults: {
    laneCount: 4,
    trackLength: 4000,
    laps: 3,
    checkpointCount: 4,
    checkpointPoints: 1,
    relay: false,
    batonPassButton: 'pass',
    obstacleDensity: 0.3,
    boostPads: 2,
    mashToRun: true,
    runButton: 'run',
    jumpButton: 'jump',
    runSpeed: 320,
    mashPower: 0.16,
    stumbleSec: 0.6,
    padBoost: 1.5,
    padBoostSec: 1.5,
  },
  controls: ['button', 'swipe', 'joystick'],
  arenaKinds: ['lanes'],
  requiredControls: (p) => {
    const out: RequiredControl[] = [
      p.mashToRun
        ? { kind: 'button', id: p.runButton, param: 'runButton', alt: [{ kind: 'hold', id: p.runButton }, { kind: 'swipe', id: '' }] }
        : { kind: 'hold', id: p.runButton, param: 'runButton', alt: [{ kind: 'button', id: p.runButton }, { kind: 'joystick', id: '' }, { kind: 'tilt', id: '' }] },
    ];
    // obstacles need jumping
    if (Math.round(p.obstacleDensity * 10) > 0) {
      out.push({ kind: 'button', id: p.jumpButton, param: 'jumpButton', alt: [{ kind: 'hold', id: p.jumpButton }, { kind: 'swipe', id: '' }] });
    }
    if (p.relay) out.push({ kind: 'button', id: p.batonPassButton, param: 'batonPassButton', alt: [{ kind: 'hold', id: p.batonPassButton }] });
    return out;
  },

  setup(ctx) {
    const s = S(ctx);
    buildLayout(ctx, s);
    const r = runnerR(ctx);
    ctx.players.forEach((p, i) => {
      const lane = laneOf(ctx, i);
      // race owns its runners: reuse an avatar if some block made one, else spawn it
      let e = ctx.entityOf(p.id);
      if (!e) e = ctx.world.spawn('player', 0, 0, { owner: p.id, r, sprite: `avatar:${p.id}`, props: { boost: 1 } });
      e.props.mover = 'race';
      e.props.lane = lane;
      const runner: Runner = {
        progress: 0, speed: 0, lap: 0, leg: 1, nextCp: 0, finished: false, jumpUntil: 0, padUntil: 0,
        taps: 0, run: false, jumpQueued: false, passQueued: false, buttons: new Map(),
      };
      s.runners.set(p.id, runner);
    });
    syncRelay(ctx, s);
    ctx.players.forEach((p, i) => {
      const e = ctx.entityOf(p.id);
      const runner = s.runners.get(p.id);
      if (e && runner) placeRunner(ctx, e, runner, laneOf(ctx, i));
    });
  },

  onInput(ctx, playerId, input: InputFrame) {
    const r = S(ctx).runners.get(playerId);
    if (!r) return;
    const P = ctx.params;
    const b = input.buttons ?? {};
    const runDown = b[P.runButton] ?? false;
    if (P.mashToRun) {
      if (pressed(r.buttons, P.runButton, runDown)) r.taps++;
      if (input.swipe === 'right') r.taps++;
      r.run = false;
    } else {
      pressed(r.buttons, P.runButton, runDown);
      r.run = runDown || (input.axes?.x ?? 0) > 0.5 || (input.tilt?.x ?? 0) > 0.5;
    }
    if (pressed(r.buttons, P.jumpButton, b[P.jumpButton] ?? false) || input.swipe === 'up') r.jumpQueued = true;
    if (pressed(r.buttons, P.batonPassButton, b[P.batonPassButton] ?? false)) r.passQueued = true;
  },

  update(ctx, dt) {
    const s = S(ctx);
    syncLive(ctx, s);
    ctx.players.forEach((p, i) => {
      const r = s.runners.get(p.id);
      const e = ctx.entityOf(p.id);
      if (!r || !e) return;
      if (!r.finished) advance(ctx, s, p.id, e, r, dt);
      placeRunner(ctx, e, r, laneOf(ctx, i));
    });
    // everyone home: short breather, then a fresh heat keeps the round going
    const live = ctx.players.filter((p) => ctx.entityOf(p.id) && s.runners.has(p.id));
    if (live.length > 0 && live.every((p) => s.runners.get(p.id)!.finished)) {
      s.heatResetAt ??= ctx.time + HEAT_GAP_SEC;
      if (ctx.time >= s.heatResetAt) newHeat(ctx, s);
    }
  },

  bot(ctx, playerId, skill) {
    const s = S(ctx);
    const r = s.runners.get(playerId);
    const e = ctx.entityOf(playerId);
    if (!r || !e) return { t: 0 };
    const P = ctx.params;
    const sk = clamp(skill, 0, 1);
    let m = s.bots.get(playerId);
    if (!m) s.bots.set(playerId, (m = { tapPhase: ctx.rng.next(), willJump: new Map() }));
    const buttons: Record<string, boolean> = {};

    // tapping rhythm: 5..9 taps/s by skill, with a little jitter
    const rate = 5 + 4 * sk;
    const phase = ctx.time * rate + m.tapPhase + ctx.rng.range(0, 0.08);
    buttons[P.runButton] = P.mashToRun ? Math.floor(phase * 2) % 2 === 0 : true;

    // jump: decide once per obstacle whether this bot will clear it (misjudges by skill)
    const lapPos = r.progress / P.trackLength;
    let jump = false;
    s.layout.forEach((f, k) => {
      if (f.kind !== 'obstacle') return;
      const gap = (f.at - lapPos) * P.trackLength;
      if (gap <= 0 || gap > Math.max(60, r.speed * 0.35)) return;
      const key = r.lap * 100 + k;
      let will = m.willJump.get(key);
      if (will === undefined) m.willJump.set(key, (will = ctx.rng.next() >= (1 - sk) * 0.4));
      if (will && gap < Math.max(40, r.speed * 0.25)) jump = true;
    });
    buttons[P.jumpButton] = jump && r.jumpUntil <= ctx.time;
    if (r.finished) m.willJump.clear();

    // relay: pass once in the zone, after a human-ish reaction delay
    if (P.relay && r.leg === 1 && r.progress >= handoff(P) - P.trackLength * HANDOFF_ZONE * 0.5) {
      m.inZoneSince ??= ctx.time;
      const ready = ctx.time - m.inZoneSince > 0.1 + (1 - sk) * 0.5;
      buttons[P.batonPassButton] = ready && Math.floor(ctx.time * 8) % 2 === 0;
    } else {
      m.inZoneSince = undefined;
      buttons[P.batonPassButton] = false;
    }
    return { t: 0, buttons };
  },
};
