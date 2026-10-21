import { z } from 'zod';
import type { BlockCtx, BlockDef } from '../block';
import type { Entity } from '../world';
import {
  type BotMem, type Vec, botMem, clamp, ensureAvatars, fallbackMove, inputDir, len, rammer, stateOf, steer,
} from './util';

export const collectSchema = z.object({
  /** Sprite key for items (art resolved by the renderer). */
  itemSprite: z.string().min(1).max(40),
  spawnEverySec: z.number().min(0.2).max(999),
  maxItems: z.number().int().min(1).max(40),
  pointsPerItem: z.number().int().min(1).max(100),
  itemRadius: z.number().min(8).max(48),
  /** Items are carried and only score when brought to the goal. */
  carryToGoal: z.boolean(),
  /** Goal centre as a fraction of arena width / height. */
  goalX: z.number().min(0).max(1),
  goalY: z.number().min(0).max(1),
  goalRadius: z.number().min(30).max(240),
  /** Most items one player can carry at once. */
  carryMax: z.number().int().min(1).max(10),
  /** Ramming a player steals one carried item (carry mode) or pointsPerItem points. */
  stealOnBump: z.boolean(),
  /** After a steal the thief can't steal again, and can't be robbed, for this long. */
  stealCooldownSec: z.number().min(0).max(10),
  goldenChance: z.number().min(0).max(1),
  goldenMultiplier: z.number().min(1).max(10),
});
export type CollectParams = z.infer<typeof collectSchema>;

interface State {
  items: number[];
  goalId?: number;
  nextSpawn: number;
  pickSeq: number;
  stealReadyAt: Map<string, number>;
  immuneUntil: Map<string, number>;
  intents: Map<string, Vec>;
  bots: Map<string, BotMem>;
}

const states = new WeakMap<object, State>();
const S = (ctx: object) =>
  stateOf<State>(states, ctx, () => ({
    items: [], nextSpawn: 0, pickSeq: 0, stealReadyAt: new Map(), immuneUntil: new Map(), intents: new Map(), bots: new Map(),
  }));

const TOUCH_SLACK = 6;

function goalPos(ctx: BlockCtx<CollectParams>): Vec {
  return { x: ctx.params.goalX * ctx.world.width, y: ctx.params.goalY * ctx.world.height };
}

/** Keep the goal entity in step with params (Tweak panel may toggle carryToGoal live). */
function syncGoal(ctx: BlockCtx<CollectParams>, s: State): Entity | undefined {
  let goal = s.goalId !== undefined ? ctx.world.get(s.goalId) : undefined;
  if (!ctx.params.carryToGoal) {
    if (goal) ctx.world.remove(goal.id);
    s.goalId = undefined;
    return undefined;
  }
  const g = goalPos(ctx);
  if (!goal) {
    goal = ctx.world.spawn('goal', g.x, g.y, { sprite: 'goal', r: ctx.params.goalRadius });
    s.goalId = goal.id;
  }
  goal.x = g.x;
  goal.y = g.y;
  goal.r = ctx.params.goalRadius;
  return goal;
}

function spawnItem(ctx: BlockCtx<CollectParams>, s: State): void {
  const P = ctx.params;
  const { width: w, height: h } = ctx.world;
  const m = 40 + P.itemRadius;
  const g = goalPos(ctx);
  let x = w / 2, y = h / 2;
  // a few tries to avoid the goal and players' feet; deterministic via ctx.rng
  for (let tries = 0; tries < 10; tries++) {
    x = ctx.rng.range(m, w - m);
    y = ctx.rng.range(m, h - m);
    if (P.carryToGoal && len(x - g.x, y - g.y) < P.goalRadius + P.itemRadius + 40) continue;
    if (ctx.players.some((p) => { const e = ctx.entityOf(p.id); return e && len(e.x - x, e.y - y) < e.r + 60; })) continue;
    break;
  }
  const golden = ctx.rng.next() < P.goldenChance;
  const it = ctx.world.spawn('item', x, y, {
    sprite: P.itemSprite, r: P.itemRadius, props: { golden, carriedBy: '', seq: 0 },
  });
  if (golden) it.tags.add('golden');
  s.items.push(it.id);
}

function itemValue(P: CollectParams, it: Entity): number {
  return it.props.golden ? Math.round(P.pointsPerItem * P.goldenMultiplier) : P.pointsPerItem;
}

function carriedBy(ctx: BlockCtx<CollectParams>, s: State, id: string): Entity[] {
  const out: Entity[] = [];
  for (const iid of s.items) {
    const it = ctx.world.get(iid);
    if (it && it.props.carriedBy === id) out.push(it);
  }
  return out.sort((a, b) => (a.props.seq as number) - (b.props.seq as number));
}

function removeItem(ctx: BlockCtx<CollectParams>, s: State, it: Entity): void {
  ctx.world.remove(it.id);
  const i = s.items.indexOf(it.id);
  if (i >= 0) s.items.splice(i, 1);
}

function steal(ctx: BlockCtx<CollectParams>, s: State, thief: Entity, victim: Entity): void {
  const P = ctx.params;
  const t = ctx.time;
  const tid = thief.owner!, vid = victim.owner!;
  if ((s.stealReadyAt.get(tid) ?? 0) > t || (s.immuneUntil.get(vid) ?? 0) > t) return;
  const data: Record<string, unknown> = { from: vid };
  if (P.carryToGoal) {
    const loot = carriedBy(ctx, s, vid).pop();
    if (!loot) return;
    if (carriedBy(ctx, s, tid).length < P.carryMax) {
      loot.props.carriedBy = tid;
      loot.props.seq = ++s.pickSeq;
    } else {
      loot.props.carriedBy = ''; // thief's hands are full: knocked loose
    }
    data.item = loot.id;
    data.golden = loot.props.golden;
  } else {
    const vp = ctx.players.find((p) => p.id === vid);
    const n = Math.min(P.pointsPerItem, vp?.score ?? 0);
    if (n <= 0) return;
    ctx.score(vid, -n, 'collect.stolen');
    ctx.score(tid, n, 'collect.steal');
    data.points = n;
  }
  s.stealReadyAt.set(tid, t + P.stealCooldownSec);
  s.immuneUntil.set(tid, t + P.stealCooldownSec);
  ctx.emit({ type: 'collect.stolen', player: tid, data });
  ctx.fx({ kind: 'particles', preset: 'burst', x: (thief.x + victim.x) / 2, y: (thief.y + victim.y) / 2 });
  ctx.fx({ kind: 'shake', strength: 0.35 });
  ctx.fx({ kind: 'sfx', name: 'hit' });
}

function pickup(ctx: BlockCtx<CollectParams>, s: State, id: string, it: Entity): void {
  const P = ctx.params;
  const golden = it.props.golden === true;
  ctx.emit({ type: 'collect.picked', player: id, data: { golden, item: it.id } });
  if (golden) {
    ctx.emit({ type: 'collect.golden', player: id });
    ctx.fx({ kind: 'flash', color: '#ffd84a' });
    ctx.fx({ kind: 'particles', preset: 'confetti', x: it.x, y: it.y });
  }
  if (P.carryToGoal) {
    it.props.carriedBy = id;
    it.props.seq = ++s.pickSeq;
    ctx.fx({ kind: 'particles', preset: 'sparkle', x: it.x, y: it.y });
    ctx.fx({ kind: 'sfx', name: 'coin' });
    return;
  }
  ctx.score(id, itemValue(P, it), golden ? 'collect.golden' : 'collect.item');
  ctx.fx({ kind: 'particles', preset: 'sparkle', x: it.x, y: it.y });
  ctx.fx({ kind: 'sfx', name: golden ? 'score' : 'coin' });
  removeItem(ctx, s, it);
}

function bank(ctx: BlockCtx<CollectParams>, s: State, id: string, at: Vec, loot: Entity[]): void {
  if (loot.length === 0) return;
  let pts = 0;
  for (const it of loot) {
    pts += itemValue(ctx.params, it);
    removeItem(ctx, s, it);
  }
  ctx.score(id, pts, 'collect.banked');
  ctx.emit({ type: 'collect.banked', player: id, data: { count: loot.length, points: pts } });
  ctx.fx({ kind: 'particles', preset: 'confetti', x: at.x, y: at.y });
  ctx.fx({ kind: 'sfx', name: 'score' });
}

export const collect: BlockDef<CollectParams> = {
  id: 'collect',
  name: 'Collect',
  summary: 'Items pop up around the arena; grab them for points, or carry them to a goal. Golden items and bump-to-steal.',
  paramsSchema: collectSchema,
  defaults: {
    itemSprite: 'item',
    spawnEverySec: 1.2,
    maxItems: 8,
    pointsPerItem: 1,
    itemRadius: 14,
    carryToGoal: false,
    goalX: 0.5,
    goalY: 0.5,
    goalRadius: 70,
    carryMax: 3,
    stealOnBump: true,
    stealCooldownSec: 1.5,
    goldenChance: 0.08,
    goldenMultiplier: 3,
  },
  controls: ['joystick'],
  arenaKinds: ['topdown'],

  setup(ctx) {
    const s = S(ctx);
    ensureAvatars(ctx as BlockCtx<unknown>, 'collect');
    syncGoal(ctx, s);
    const n = Math.ceil(ctx.params.maxItems / 2);
    for (let i = 0; i < n; i++) spawnItem(ctx, s);
    s.nextSpawn = ctx.params.spawnEverySec;
  },

  onInput(ctx, playerId, input) {
    const e = ctx.entityOf(playerId);
    if (!e || e.props.mover !== 'collect') return;
    const s = S(ctx);
    let d = s.intents.get(playerId);
    if (!d) s.intents.set(playerId, (d = { x: 0, y: 0 }));
    inputDir(input, 'joystick', 1.5, d);
  },

  update(ctx, dt) {
    const s = S(ctx);
    const P = ctx.params;
    const goal = syncGoal(ctx, s);

    // spawn on a timer up to maxItems
    if (ctx.time >= s.nextSpawn) {
      if (s.items.length < P.maxItems) spawnItem(ctx, s);
      s.nextSpawn = ctx.time + P.spawnEverySec;
    }

    // bump-to-steal (before movement rewrites velocities)
    if (P.stealOnBump) {
      const ps = ctx.players;
      for (let i = 0; i < ps.length; i++) {
        const a = ctx.entityOf(ps[i]!.id);
        if (!a) continue;
        for (let j = i + 1; j < ps.length; j++) {
          const b = ctx.entityOf(ps[j]!.id);
          if (!b || len(b.x - a.x, b.y - a.y) > a.r + b.r + TOUCH_SLACK) continue;
          const thief = rammer(a, b, ctx.time);
          if (thief) steal(ctx, s, thief, thief === a ? b : a);
        }
      }
    }

    // pickups (players in join order; the grid is fresh because nothing moved yet)
    ctx.world.invalidate();
    for (const p of ctx.players) {
      const e = ctx.entityOf(p.id);
      if (!e) continue;
      let held = P.carryToGoal ? carriedBy(ctx, s, p.id).length : 0;
      for (const it of ctx.world.query(e.x, e.y, e.r)) {
        if (it.kind !== 'item' || it.props.carriedBy !== '' || !s.items.includes(it.id)) continue;
        if (P.carryToGoal && held >= P.carryMax) break;
        pickup(ctx, s, p.id, it);
        held++;
      }
    }

    // carried items trail their carrier; bank at the goal; drop if the carrier is gone
    for (const iid of s.items.slice()) {
      const it = ctx.world.get(iid);
      if (!it || it.props.carriedBy === '') continue;
      const owner = it.props.carriedBy as string;
      if (!P.carryToGoal) {
        // carry mode switched off live: carried items pay out
        bank(ctx, s, owner, it, [it]);
        continue;
      }
      if (!ctx.entityOf(owner)) it.props.carriedBy = '';
    }
    if (P.carryToGoal) {
      for (const p of ctx.players) {
        const e = ctx.entityOf(p.id);
        if (!e) continue;
        const loot = carriedBy(ctx, s, p.id);
        if (goal && loot.length > 0 && len(e.x - goal.x, e.y - goal.y) <= goal.r) {
          bank(ctx, s, p.id, goal, loot);
          continue;
        }
        const sp = len(e.vx, e.vy);
        const bx = sp > 1 ? -e.vx / sp : 0, by = sp > 1 ? -e.vy / sp : -1;
        loot.forEach((it, k) => {
          const off = e.r + it.r + k * (it.r * 1.4);
          it.x = e.x + bx * off;
          it.y = e.y + by * off;
          it.vx = it.vy = 0;
        });
      }
    }

    fallbackMove(ctx as BlockCtx<unknown>, 'collect', s.intents, dt);
  },

  bot(ctx, playerId, skill) {
    const s = S(ctx);
    const P = ctx.params;
    const e = ctx.entityOf(playerId);
    if (!e) return { t: 0 };
    const m = botMem(s.bots, playerId);
    const sk = clamp(skill, 0, 1);

    const free: Entity[] = [];
    for (const iid of s.items) {
      const it = ctx.world.get(iid);
      if (it && it.props.carriedBy === '') free.push(it);
    }

    if (P.carryToGoal) {
      const held = carriedBy(ctx, s, playerId).length;
      // better bots fill their hands before the trip; everyone banks when full or nothing is left
      const want = Math.max(1, Math.round(P.carryMax * (0.4 + 0.6 * sk)));
      if (held === 0 && m.targetId === -1) m.targetId = undefined;
      if (held > 0 && (held >= want || free.length === 0 || m.targetId === -1)) {
        m.targetId = -1; // committed to banking until the loot is gone
        const g = goalPos(ctx);
        return { t: 0, axes: steer(ctx as BlockCtx<unknown>, m, e, g.x, g.y, sk) };
      }
    }

    let target = m.targetId !== undefined && m.targetId >= 0 ? ctx.world.get(m.targetId) : undefined;
    if (!target || target.props.carriedBy !== '' || ctx.time >= m.until) {
      target = undefined;
      if (free.length > 0) {
        if (ctx.rng.next() < (1 - sk) * 0.35) {
          target = ctx.rng.pick(free); // a plausible misjudgement
        } else {
          let best = Infinity;
          for (const it of free) {
            const c = len(it.x - e.x, it.y - e.y) / (it.props.golden ? P.goldenMultiplier : 1);
            if (c < best) { best = c; target = it; }
          }
        }
      }
      m.targetId = target?.id;
      // slower bots take longer to reconsider
      m.until = ctx.time + ctx.rng.range(0.4, 0.8) + (1 - sk) * 0.8;
    }
    if (!target) return { t: 0 };
    return { t: 0, axes: steer(ctx as BlockCtx<unknown>, m, e, target.x, target.y, sk) };
  },
};
