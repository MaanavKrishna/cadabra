/**
 * BALL SPORT: one physics ball, two goals (or free-for-all keep-away). Needs rigid-body physics
 * (the runtime turns it on for this block). Pair it with arena-move for movement and dash kicks.
 */
import { z } from 'zod';
import type { BlockCtx, BlockDef } from '../block';
import type { Entity } from '../world';
import { type BotMem, botMem, callout, clamp, ensureAvatars, len, stateOf, steer } from './util';

export const ballSportSchema = z.object({
  mode: z.enum(['goals', 'keepaway']).describe("goals = two goals on the left/right walls (teams: team 0 defends the left, team 1 the right; free-for-all: whoever touched the ball last scores in either goal). keepaway = no goals: whoever touched the ball last scores keepAwayPoints every keepAwayEverySec."),
  ballSize: z.number().min(0.6).max(3).describe('Ball size (1 = radius 24 px, a bit bigger than a player; 2 = a giant beach ball).'),
  ballBounce: z.number().min(0).max(1.2).describe('Ball restitution: 0.4 = heavy, 0.85 = default lively, 1.1 = superball.'),
  ballMass: z.number().min(0.1).max(3).describe('Ball mass relative to a crate (0.35 default: players punt it far; 2 = a heavy medicine ball).'),
  ballDamping: z.number().min(0).max(5).describe('How fast the rolling ball slows (0 = never stops, 0.4 default).'),
  goalSize: z.number().min(120).max(560).describe('Goal mouth height, px (arena is usually 720 tall).'),
  goalDepth: z.number().min(30).max(140).describe('Goal depth from the wall, px: the ball scores once its centre is inside.'),
  goalPoints: z.number().int().min(1).max(10).describe('Points to the scorer (the scoring side\'s last toucher).'),
  assistPoints: z.number().int().min(0).max(10).describe('Points to every other player on the scoring team.'),
  behindBonus: z.number().int().min(0).max(6).describe('Comeback: extra points for a goal scored by the side (team, or player in free-for-all) that is behind on score ("COMEBACK GOAL!").'),
  kickPower: z.number().min(0).max(1500).describe('Extra px/s a DASHING player adds to the ball on contact (a power shot).'),
  kickoffReset: z.boolean().describe('After a goal the ball returns to the centre and players to kickoff spots, frozen for kickoffSec.'),
  kickoffSec: z.number().min(0).max(3).describe('Freeze after a kickoff reset, s.'),
  keepAwayEverySec: z.number().min(0.5).max(5).describe('keepaway: seconds between possession points.'),
  keepAwayPoints: z.number().int().min(1).max(5).describe('keepaway: points per tick to whoever touched the ball last.'),
  multiballEventKind: z.string().max(40).describe("Timeline event kind (exact) that drops an extra ball in (max 3 balls). '' = off."),
  callout: z.string().max(24).describe("Namespace for headline events (<callout>.goal with data.moment 'goal', .multiball); '' = off."),
});
export type BallSportParams = z.infer<typeof ballSportSchema>;

type Ctx = BlockCtx<BallSportParams>;
const U = (ctx: Ctx) => ctx as unknown as BlockCtx<unknown>;
const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d);
const MAX_BALLS = 3;

interface State {
  balls: number[];
  goals: Entity[];
  /** Kickoff freeze until (sim s). */
  frozenUntil: number;
  nextTick: number;
  bots: Map<string, BotMem>;
  /** Last toucher per team (goal credit); '' = none yet. */
  lastByTeam: [string, string];
  lastAny: string;
}
const states = new WeakMap<object, State>();
const S = (ctx: object) => stateOf<State>(states, ctx, () => ({ balls: [], goals: [], frozenUntil: 0, nextTick: 0, bots: new Map(), lastByTeam: ['', ''], lastAny: '' }));

const teamOf = (ctx: Ctx, id: string) => ctx.players.find((p) => p.id === id)?.team;

function spawnBall(ctx: Ctx, x: number, y: number): Entity | undefined {
  const P = ctx.params;
  const extra = { restitution: P.ballBounce, mass: P.ballMass, damping: P.ballDamping, lastTouch: '' };
  const ph = ctx.physics;
  const b = ph
    ? ph.spawnProp('ball', x, y, P.ballSize, extra)
    : ctx.world.spawn('ball', x, y, { r: 24 * P.ballSize, sprite: 'ball', props: { body: 'dynamic', shape: 'circle', size: P.ballSize, angle: 0, av: 0, ...extra } });
  S(ctx).balls.push(b.id);
  return b;
}

/** Kickoff spots: each team in its own half, facing the centre. */
function kickoff(ctx: Ctx): void {
  const { width: w, height: h } = ctx.world;
  const s = S(ctx);
  const teamed = ctx.spec.teams === 2;
  const idx: [number, number] = [0, 0];
  ctx.players.forEach((p, i) => {
    const e = ctx.entityOf(p.id);
    if (!e) return;
    const side = teamed ? (p.team === 1 ? 1 : -1) : i % 2 === 0 ? -1 : 1;
    const k = teamed ? idx[p.team === 1 ? 1 : 0]++ : Math.floor(i / 2);
    e.x = w / 2 + side * (w * 0.22 + (k % 2) * w * 0.1);
    e.y = h / 2 + (k === 0 ? 0 : k % 2 === 1 ? -h * 0.22 : h * 0.22);
    e.vx = e.vy = 0;
    e.props.stunUntil = Math.max(num(e.props.stunUntil), ctx.time + ctx.params.kickoffSec);
  });
  for (const id of s.balls) {
    const b = ctx.world.get(id);
    if (!b) continue;
    b.x = w / 2; b.y = h / 2; b.vx = b.vy = 0; b.props.av = 0; b.props.lastTouch = '';
  }
  s.lastByTeam = ['', ''];
  s.lastAny = '';
  s.frozenUntil = ctx.time + ctx.params.kickoffSec;
}

function goal(ctx: Ctx, s: State, ball: Entity, side: -1 | 1): void {
  const P = ctx.params;
  const teamed = ctx.spec.teams === 2;
  // the ball is in the goal on `side`: the team defending it (-1 => team 0) concedes
  const scoringTeam: 0 | 1 = side === -1 ? 1 : 0;
  let scorer = teamed ? s.lastByTeam[scoringTeam] : s.lastAny;
  const own = teamed && scorer === '';
  if (own) scorer = ctx.players.find((p) => p.team === scoringTeam)?.id ?? '';
  if (scorer) {
    // comeback: the side behind on score gets behindBonus on top
    const side = (id: string) => (teamed ? ctx.players.filter((p) => p.team === teamOf(ctx, id)) : ctx.players.filter((p) => p.id === id));
    const mine = side(scorer).reduce((a, p) => a + p.score, 0);
    const best = teamed
      ? Math.max(...[0, 1].map((tm) => ctx.players.filter((p) => p.team === tm).reduce((a, p) => a + p.score, 0)))
      : Math.max(...ctx.players.map((p) => p.score));
    const comeback = P.behindBonus > 0 && mine < best;
    ctx.score(scorer, P.goalPoints + (comeback ? P.behindBonus : 0), own ? 'OWN GOAL!' : comeback ? 'COMEBACK GOAL!' : 'GOAL!');
    if (teamed && P.assistPoints > 0) {
      for (const p of ctx.players) if (p.team === scoringTeam && p.id !== scorer) ctx.score(p.id, P.assistPoints, 'ASSIST');
    }
  }
  const g = s.goals.find((e) => e.props.side === side);
  if (g) g.props.hitAt = ctx.time;
  const data: Record<string, unknown> = { side, own, x: ball.x, y: ball.y };
  if (teamed) data.team = scoringTeam;
  callout(U(ctx), P.callout, 'goal', scorer || undefined, data);
  ctx.emit({ type: 'ball.goal', player: scorer || undefined, data });
  ctx.fx({ kind: 'shake', strength: 0.6 });
  ctx.fx({ kind: 'particles', preset: 'confetti', x: ball.x, y: ball.y });
  ctx.fx({ kind: 'sfx', name: 'goal' });
  if (P.kickoffReset) kickoff(ctx);
  else { ball.x = ctx.world.width / 2; ball.y = ctx.world.height / 2; ball.vx = ball.vy = 0; }
}

export const ballSport: BlockDef<BallSportParams> = {
  id: 'ball-sport',
  name: 'Ball Sport',
  summary: 'A physics ball and two goals (2v2 car-soccer / pinball football) or free-for-all keep-away. Dash into the ball for a power shot; it banks off walls. Needs arena-move for movement.',
  paramsSchema: ballSportSchema,
  defaults: {
    mode: 'goals',
    ballSize: 1.3,
    ballBounce: 0.85,
    ballMass: 0.35,
    ballDamping: 0.4,
    goalSize: 260,
    goalDepth: 60,
    goalPoints: 3,
    assistPoints: 1,
    behindBonus: 0,
    kickPower: 520,
    kickoffReset: true,
    kickoffSec: 1,
    keepAwayEverySec: 1,
    keepAwayPoints: 1,
    multiballEventKind: '',
    callout: 'play',
  },
  controls: ['joystick', 'tilt', 'button'],
  arenaKinds: ['topdown'],
  requiredControls: () => [{ kind: 'joystick', id: '', alt: [{ kind: 'tilt', id: '' }] }],
  usesPhysics: () => true,

  setup(ctx) {
    ensureAvatars(U(ctx), 'ball-sport');
    const s = S(ctx);
    const { width: w, height: h } = ctx.world;
    const P = ctx.params;
    if (P.mode === 'goals') {
      for (const side of [-1, 1] as const) {
        const x = side === -1 ? P.goalDepth / 2 : w - P.goalDepth / 2;
        const g = ctx.world.spawn('goal', x, h / 2, {
          r: Math.min(P.goalSize, h) / 2, sprite: 'net',
          props: { w: P.goalDepth, h: Math.min(P.goalSize, h - 40), side, hw: P.goalDepth / 2, hh: Math.min(P.goalSize, h - 40) / 2, hitAt: -1 },
        });
        if (ctx.spec.teams === 2) g.team = side === -1 ? 0 : 1;
        s.goals.push(g);
      }
    }
    spawnBall(ctx, w / 2, h / 2);
    kickoff(ctx);
    s.frozenUntil = 0;
    s.nextTick = P.keepAwayEverySec;
  },

  onTimeline(ctx, ev) {
    const P = ctx.params;
    const s = S(ctx);
    if (P.multiballEventKind === '' || ev.kind !== P.multiballEventKind || s.balls.length >= MAX_BALLS) return;
    const b = spawnBall(ctx, ctx.world.width / 2, ctx.world.height * 0.25);
    if (b) b.vy = 200;
    callout(U(ctx), P.callout, 'multiball', undefined, { balls: s.balls.length });
  },

  onInput() {},

  update(ctx) {
    const s = S(ctx);
    const P = ctx.params;
    const t = ctx.time;
    s.balls = s.balls.filter((id) => ctx.world.get(id));
    if (s.balls.length === 0) spawnBall(ctx, ctx.world.width / 2, ctx.world.height / 2);
    // touches (last physics step): credit, and a dashing player's power shot
    for (const c of ctx.physics?.contacts() ?? []) {
      for (const [ball, other, sgn] of [[c.a, c.b, 1], [c.b, c.a, -1]] as const) {
        if (ball.kind !== 'ball' || other.kind !== 'player' || other.owner === undefined) continue;
        const id = other.owner;
        ball.props.lastTouch = id;
        s.lastAny = id;
        const tm = teamOf(ctx, id);
        if (tm !== undefined) s.lastByTeam[tm] = id;
        if (other.props.dashing === true && P.kickPower > 0) {
          // normal points ball→player when the ball is a: kick along -n (away from the player)
          ball.vx += -sgn * c.nx * P.kickPower;
          ball.vy += -sgn * c.ny * P.kickPower;
          ball.props.hitAt = t;
          ball.props.impulse = 1.5;
          ctx.emit({ type: 'ball.kick', player: id, data: { power: Math.round(c.speed + P.kickPower) } });
          ctx.fx({ kind: 'sfx', name: 'kick' });
        }
      }
    }
    if (t < s.frozenUntil) {
      for (const id of s.balls) { const b = ctx.world.get(id); if (b) { b.vx = b.vy = 0; } }
      return;
    }
    if (P.mode === 'goals') {
      const { width: w, height: h } = ctx.world;
      for (const id of s.balls) {
        const b = ctx.world.get(id);
        if (!b) continue;
        const mouth = Math.min(P.goalSize, h - 40) / 2;
        if (Math.abs(b.y - h / 2) > mouth) continue;
        if (b.x < P.goalDepth) { goal(ctx, s, b, -1); break; }
        if (b.x > w - P.goalDepth) { goal(ctx, s, b, 1); break; }
      }
    } else if (t >= s.nextTick) {
      s.nextTick = t + P.keepAwayEverySec;
      if (s.lastAny) ctx.score(s.lastAny, P.keepAwayPoints, 'POSSESSION');
    }
  },

  bot(ctx, playerId, skill) {
    const s = S(ctx);
    const P = ctx.params;
    const e = ctx.entityOf(playerId);
    if (!e) return { t: 0 };
    const m = botMem(s.bots, playerId);
    const { width: w, height: h } = ctx.world;
    // nearest ball
    let ball: Entity | undefined, bd = Infinity;
    for (const id of s.balls) {
      const b = ctx.world.get(id);
      if (b && len(b.x - e.x, b.y - e.y) < bd) { ball = b; bd = len(b.x - e.x, b.y - e.y); }
    }
    if (!ball) return { t: 0 };
    const sk = clamp(skill, 0, 1);
    const key = typeof e.props.dashKey === 'string' ? e.props.dashKey : 'dash';
    const team = teamOf(ctx, playerId);
    // attack direction: team 0 shoots right, team 1 left; FFA/keepaway: away from the nearest rival
    let gx = team === 1 ? P.goalDepth / 2 : w - P.goalDepth / 2, gy = h / 2;
    if (P.mode === 'keepaway' || team === undefined) {
      if (P.mode === 'goals') { gx = ball.x < w / 2 ? P.goalDepth / 2 : w - P.goalDepth / 2; }
      else { gx = w - ball.x; gy = h - ball.y; }
    }
    // defender: my team's player farther from the ball guards our goal while the ball is on our side
    if (P.mode === 'goals' && team !== undefined) {
      const mates = ctx.players.filter((p) => p.team === team && p.id !== playerId).map((p) => ctx.entityOf(p.id)).filter((x): x is Entity => !!x);
      const closer = mates.some((o) => len(ball!.x - o.x, ball!.y - o.y) < bd - 20);
      const ownX = team === 1 ? w - P.goalDepth : P.goalDepth;
      const danger = Math.abs(ball.x - ownX) < w * 0.35;
      if (closer && !danger) {
        const tx = ownX + (ball.x - ownX) * 0.3, ty = h / 2 + (ball.y - h / 2) * 0.5;
        return { t: 0, axes: steer(U(ctx), m, e, tx, ty, sk), buttons: { [key]: false } };
      }
    }
    const dx = gx - ball.x, dy = gy - ball.y, dl = len(dx, dy) || 1;
    const ux = dx / dl, uy = dy / dl;
    const back = ball.r + e.r + 14;
    const px = ball.x - ux * back, py = ball.y - uy * back;
    // which side of the ball am I on (along the attack line)?
    const along = ((e.x - ball.x) * ux + (e.y - ball.y) * uy) / (bd || 1);
    let tx = px, ty = py;
    if (along > -0.3) {
      // wrong side: loop around the ball (sideways first) instead of pushing it home
      const sx = -uy, sy = ux;
      const sgn = (e.x - ball.x) * sx + (e.y - ball.y) * sy >= 0 ? 1 : -1;
      tx = ball.x + sx * sgn * back * 1.6 - ux * back * 0.6;
      ty = ball.y + sy * sgn * back * 1.6 - uy * back * 0.6;
    } else if (len(px - e.x, py - e.y) < 26) {
      tx = ball.x + ux * 40; ty = ball.y + uy * 40;
    }
    tx = clamp(tx, e.r, w - e.r); ty = clamp(ty, e.r, h - e.r);
    const axes = steer(U(ctx), m, e, tx, ty, sk);
    // dash for a shot when lined up behind the ball
    const toB = { x: (ball.x - e.x) / (bd || 1), y: (ball.y - e.y) / (bd || 1) };
    const aligned = toB.x * ux + toB.y * uy;
    const shoot = bd < 120 && aligned > 0.75 - 0.2 * sk && ctx.rng.next() < 0.1 + 0.25 * sk;
    return { t: 0, axes, buttons: { [key]: shoot } };
  },
};
