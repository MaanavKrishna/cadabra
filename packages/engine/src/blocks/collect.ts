import { z } from 'zod';
import type { InputFrame } from '@cadabra/spec';
import type { BlockCtx, BlockDef } from '../block';
import type { Entity } from '../world';
import {
  type BotMem, type Vec, botMem, callout, clamp, consumeRam, ensureAvatars, fallbackMove, inputDir, isStunned, labelOf, len,
  onFloor, rammer, stateOf, steer,
} from './util';

export const collectSchema = z.object({
  itemSprite: z.string().min(1).max(40).describe('Sprite key for items (art resolved by the renderer).'),
  spawnEverySec: z.number().min(0.2).max(999).describe('Seconds between item spawns.'),
  maxItems: z.number().int().min(1).max(40).describe('Most items on the field at once.'),
  pointsPerItem: z.number().int().min(1).max(100).describe('Points per item (on pickup, or at the goal in carry mode).'),
  itemRadius: z.number().min(8).max(48).describe('Item size, px.'),
  carryToGoal: z.boolean().describe('Items are carried and only score when brought to the goal.'),
  goalX: z.number().min(0).max(1).describe('Goal centre X as a fraction of arena width (carry mode).'),
  goalY: z.number().min(0).max(1).describe('Goal centre Y as a fraction of arena height (carry mode).'),
  goalRadius: z.number().min(30).max(240).describe('Goal size, px (carry mode).'),
  carryMax: z.number().int().min(1).max(10).describe('Most items one player can carry at once.'),
  stealOnBump: z.boolean().describe('Ramming a player steals one carried item (carry mode) or pointsPerItem points.'),
  stealCooldownSec: z.number().min(0.3).max(10).describe("After a steal the thief can't steal again, and can't be robbed, for this long."),
  goldenChance: z.number().min(0).max(1).describe('Chance (0..1) that a spawned item is golden.'),
  goldenMultiplier: z.number().min(1).max(10).describe('Golden items are worth this many times pointsPerItem.'),
  spawnArea: z.enum(['anywhere', 'centre']).describe("Where items appear: anywhere, or within spawnRadius of the arena centre (e.g. around a sleeping guard: the risky zone)."),
  spawnRadius: z.number().min(60).max(800).describe("Max distance of a spawn from the arena centre when spawnArea is 'centre', px."),
  homeBases: z.boolean().describe("Carry mode: every player gets their own basket (kind 'base', in their colour, spread along the edges); loot banks only at your own basket."),
  bankBonus: z.number().int().min(0).max(5).describe('Carry mode: extra points per item beyond the first banked in one trip (1 => 1, 3, 6 for 1, 2, 3 items): rewards greedy trips.'),
  carrySlowdown: z.number().min(0).max(0.3).describe('Carry mode: top speed lost per carried item, as a fraction (0.12 => 3 items = 64% speed).'),
  carryNoise: z.number().min(0).max(2).describe('Carry mode: extra noise per carried item, as a multiple of normal (guards hear you better: 0.6 => 3 items = 2.8x as loud).'),
  goldenEventKind: z.string().max(40).describe("Timeline event kind (exact) that drops one golden item next to the guard / arena centre: a mid-round jackpot. '' = off."),
  frenzyEventKind: z.string().max(40).describe("Timeline event kind (exact) that fills the field with items at once (a loot frenzy). '' = off."),
  callout: z.string().max(24).describe("Namespace for the headline events the TV calls out (<callout>.bank, .steal, .golden); '' = off."),
  teamBases: z.boolean().describe("Carry mode, team games: one base per team (kind 'base', team-tinted, left and right edges); loot banks at your team's base, and bumps never rob a teammate. Overrides homeBases."),
  stealNeedsDash: z.boolean().describe('Only a dashing avatar (arena-move dash) can steal or knock loot loose; ordinary bumps do nothing.'),
  knockLoose: z.boolean().describe('Carry mode: a steal knocks one carried item loose onto the floor (anyone can grab it) instead of handing it to the thief.'),
  bankLabel: z.string().min(1).max(24).describe("Popup reason when loot is banked (e.g. 'BANKED')."),
});
export type CollectParams = z.infer<typeof collectSchema>;

interface CBot extends BotMem {
  /** Personality: items to gather before heading home (1..carryMax). */
  greed: number;
  /** Personality: 0..1 appetite for stealing. */
  aggro: number;
  /** Intercept target while stealing, until `huntUntil`. */
  prey?: string;
  huntUntil: number;
}

interface State {
  items: number[];
  goalId?: number;
  /** Home basket entity per player (homeBases). */
  bases: Map<string, number>;
  /** Last fumbleAt honoured per player. */
  fumbled: Map<string, number>;
  lastSpawn: number;
  /** Avatar pairs in contact last step: one bump = one steal attempt. */
  touching: Set<string>;
  pickSeq: number;
  stealReadyAt: Map<string, number>;
  immuneUntil: Map<string, number>;
  intents: Map<string, Vec>;
  bots: Map<string, CBot>;
}

const states = new WeakMap<object, State>();
const S = (ctx: object) =>
  stateOf<State>(states, ctx, () => ({
    items: [], bases: new Map(), fumbled: new Map(), lastSpawn: 0, touching: new Set(), pickSeq: 0, stealReadyAt: new Map(), immuneUntil: new Map(), intents: new Map(), bots: new Map(),
  }));

const TOUCH_SLACK = 6;
/** A robbed carrier tumbles: stunned this long, knocked away at this speed. */
const STEAL_STUN_SEC = 0.35;
const STEAL_KNOCK = 260;
/** Fumbled loot scatters this far from the carrier, px. */
const FUMBLE_MIN = 50;
const FUMBLE_MAX = 110;

/** Where a player's home basket sits: corners first, then edge midpoints. */
function basePos(ctx: BlockCtx<CollectParams>, i: number): Vec {
  const { width: w, height: h } = ctx.world;
  const m = ctx.params.goalRadius + 10;
  const spots: Vec[] = [
    { x: m, y: m }, { x: w - m, y: h - m }, { x: w - m, y: m }, { x: m, y: h - m },
    { x: w / 2, y: m }, { x: w / 2, y: h - m }, { x: m, y: h / 2 }, { x: w - m, y: h / 2 },
  ];
  return spots[i % spots.length]!;
}

function useBases(P: CollectParams): boolean {
  return P.carryToGoal && (P.homeBases || P.teamBases);
}

/** Base key for a player: its team ('team:N') with teamBases in a team game, else its id. */
function baseKey(ctx: BlockCtx<CollectParams>, id: string): string {
  if (!ctx.params.teamBases) return id;
  const t = ctx.players.find((p) => p.id === id)?.team;
  return t === undefined ? id : `team:${t}`;
}

const mates = (ctx: BlockCtx<CollectParams>, a: string, b: string): boolean => {
  if (!ctx.params.teamBases) return false;
  const ta = ctx.players.find((p) => p.id === a)?.team;
  return ta !== undefined && ta === ctx.players.find((p) => p.id === b)?.team;
};

/** Keep one basket per player in step with params (homeBases may be toggled live). */
function syncBases(ctx: BlockCtx<CollectParams>, s: State): void {
  if (!useBases(ctx.params)) {
    for (const id of s.bases.values()) ctx.world.remove(id);
    s.bases.clear();
    return;
  }
  const { width: w, height: h } = ctx.world;
  ctx.players.forEach((p, i) => {
    const key = baseKey(ctx, p.id);
    let b = s.bases.has(key) ? ctx.world.get(s.bases.get(key)!) : undefined;
    if (!b) {
      const team = key.startsWith('team:') ? Number(key.slice(5)) as 0 | 1 : undefined;
      const m = ctx.params.goalRadius + 10;
      const at = team !== undefined ? { x: team === 0 ? m : w - m, y: h / 2 } : basePos(ctx, i);
      const opts: Parameters<typeof ctx.world.spawn>[3] = team !== undefined
        ? { sprite: 'base', r: ctx.params.goalRadius, team, props: { home: true, slot: team, teamBase: true } }
        : { owner: p.id, sprite: 'base', r: ctx.params.goalRadius, props: { home: true, slot: i } };
      if (team === undefined && p.team !== undefined) opts.team = p.team;
      b = ctx.world.spawn('base', at.x, at.y, opts);
      s.bases.set(key, b.id);
    }
    b.r = ctx.params.goalRadius;
  });
}

/** Where `id` banks: its own basket, else the shared goal. */
function bankSpot(ctx: BlockCtx<CollectParams>, s: State, id: string): Entity | undefined {
  if (useBases(ctx.params)) {
    const b = s.bases.get(baseKey(ctx, id));
    return b !== undefined ? ctx.world.get(b) : undefined;
  }
  return s.goalId !== undefined ? ctx.world.get(s.goalId) : undefined;
}

function goalPos(ctx: BlockCtx<CollectParams>): Vec {
  return { x: ctx.params.goalX * ctx.world.width, y: ctx.params.goalY * ctx.world.height };
}

/** Keep the goal entity in step with params (Tweak panel may toggle carryToGoal live). */
function syncGoal(ctx: BlockCtx<CollectParams>, s: State): Entity | undefined {
  let goal = s.goalId !== undefined ? ctx.world.get(s.goalId) : undefined;
  if (!ctx.params.carryToGoal || ctx.params.homeBases || ctx.params.teamBases) {
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
  const guards = ctx.world.ofKind('guard');
  // a few tries to avoid goals, guards, players' feet and missing floor; deterministic via ctx.rng
  for (let tries = 0; tries < 12; tries++) {
    if (P.spawnArea === 'centre') {
      const a = ctx.rng.range(0, Math.PI * 2);
      const r = Math.sqrt(ctx.rng.next()) * P.spawnRadius;
      x = clamp(w / 2 + Math.cos(a) * r, m, w - m);
      y = clamp(h / 2 + Math.sin(a) * r, m, h - m);
    } else {
      x = ctx.rng.range(m, w - m);
      y = ctx.rng.range(m, h - m);
    }
    if (P.carryToGoal && !useBases(P) && len(x - g.x, y - g.y) < P.goalRadius + P.itemRadius + 40) continue;
    if ([...s.bases.values()].some((id) => { const b = ctx.world.get(id); return b && len(b.x - x, b.y - y) < b.r + P.itemRadius + 30; })) continue;
    let nearGuard = false;
    for (const gd of guards) if (len(gd.x - x, gd.y - y) < gd.r + P.itemRadius + 24) nearGuard = true;
    if (nearGuard) continue;
    if (!onFloor(ctx as BlockCtx<unknown>, x, y, true)) continue;
    if (ctx.players.some((p) => { const e = ctx.entityOf(p.id); return e && len(e.x - x, e.y - y) < e.r + 60; })) continue;
    break;
  }
  spawnAt(ctx, s, x, y, ctx.rng.next() < P.goldenChance);
}

function spawnAt(ctx: BlockCtx<CollectParams>, s: State, x: number, y: number, golden: boolean): Entity {
  const P = ctx.params;
  const it = ctx.world.spawn('item', x, y, {
    sprite: P.itemSprite, r: P.itemRadius, props: { golden, carriedBy: '', seq: 0 },
  });
  if (golden) it.tags.add('golden');
  s.items.push(it.id);
  return it;
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
  if (mates(ctx, tid, vid)) return;
  if (P.stealNeedsDash && thief.props.dashing !== true) return;
  const data: Record<string, unknown> = { from: vid };
  if (P.carryToGoal) {
    const loot = carriedBy(ctx, s, vid).pop();
    if (!loot) return;
    if (!P.knockLoose && carriedBy(ctx, s, tid).length < P.carryMax) {
      loot.props.carriedBy = tid;
      loot.props.seq = ++s.pickSeq;
    } else {
      // knocked loose: it skids off to the side, free for anyone
      loot.props.carriedBy = '';
      const { width: w, height: h } = ctx.world;
      const a = ctx.rng.range(0, Math.PI * 2), r = ctx.rng.range(FUMBLE_MIN, FUMBLE_MAX);
      if (ctx.physics) {
        // physics: it rolls away from the hit (thief → victim, ± a random spread) and bounces off walls/props
        const hx = victim.x - thief.x, hy = victim.y - thief.y, hl = Math.hypot(hx, hy) || 1;
        const ang = Math.atan2(hy, hx) + (a / Math.PI - 1) * 1.1;
        const off = victim.r + loot.r + 4;
        loot.x = clamp(victim.x + Math.cos(ang) * off, loot.r, w - loot.r);
        loot.y = clamp(victim.y + Math.sin(ang) * off, loot.r, h - loot.r);
        const sp = 300 + r * 3;
        loot.vx = Math.cos(ang) * sp; loot.vy = Math.sin(ang) * sp;
        Object.assign(loot.props, { body: 'dynamic', shape: 'circle', group: 'loot', damping: 2.2, restitution: 0.75, mass: 0.4, angle: 0, av: (hx / hl) * 9 });
      } else {
        loot.x = clamp(victim.x + Math.cos(a) * r, loot.r, w - loot.r);
        loot.y = clamp(victim.y + Math.sin(a) * r, loot.r, h - loot.r);
      }
      data.loose = true;
    }
    data.item = loot.id;
    data.golden = loot.props.golden;
  } else {
    const vp = ctx.players.find((p) => p.id === vid);
    const n = Math.min(P.pointsPerItem, vp?.score ?? 0);
    if (n <= 0) return;
    ctx.score(vid, -n, 'Robbed!');
    ctx.score(tid, n, 'Stole!');
    data.points = n;
  }
  s.stealReadyAt.set(tid, t + P.stealCooldownSec);
  s.immuneUntil.set(tid, t + P.stealCooldownSec);
  // the victim tumbles away (comedy, and it breaks contact)
  const dx = victim.x - thief.x, dy = victim.y - thief.y;
  const d = len(dx, dy) || 1;
  victim.vx = (dx / d) * STEAL_KNOCK;
  victim.vy = (dy / d) * STEAL_KNOCK;
  victim.props.stunUntil = Math.max(typeof victim.props.stunUntil === 'number' ? victim.props.stunUntil : 0, t + STEAL_STUN_SEC);
  ctx.emit({ type: 'collect.stolen', player: tid, data });
  callout(ctx as BlockCtx<unknown>, P.callout, 'steal', tid, data);
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
    callout(ctx as BlockCtx<unknown>, P.callout, 'golden', id, { phase: 'grab' });
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
  ctx.score(id, itemValue(P, it), golden ? 'Golden!' : labelOf(P.itemSprite));
  ctx.fx({ kind: 'particles', preset: 'sparkle', x: it.x, y: it.y });
  ctx.fx({ kind: 'sfx', name: golden ? 'score' : 'coin' });
  removeItem(ctx, s, it);
}

function bank(ctx: BlockCtx<CollectParams>, s: State, id: string, at: Vec, loot: Entity[]): void {
  if (loot.length === 0) return;
  const n = loot.length;
  let pts = (ctx.params.bankBonus * n * (n - 1)) / 2;
  let golden = false;
  for (const it of loot) {
    pts += itemValue(ctx.params, it);
    if (it.props.golden) golden = true;
    removeItem(ctx, s, it);
  }
  ctx.score(id, pts, ctx.params.bankLabel);
  ctx.emit({ type: 'collect.banked', player: id, data: { count: n, points: pts } });
  callout(ctx as BlockCtx<unknown>, ctx.params.callout, 'bank', id, { count: n, points: pts, golden });
  if (golden) callout(ctx as BlockCtx<unknown>, ctx.params.callout, 'golden', id, { phase: 'bank' });
  ctx.fx({ kind: 'particles', preset: 'confetti', x: at.x, y: at.y });
  ctx.fx({ kind: 'sfx', name: 'score' });
}

/** Drop everything `id` carries, scattered around (x, y). */
function fumble(ctx: BlockCtx<CollectParams>, s: State, id: string, e: Entity): void {
  const loot = carriedBy(ctx, s, id);
  if (loot.length === 0) return;
  const { width: w, height: h } = ctx.world;
  for (const it of loot) {
    const a = ctx.rng.range(0, Math.PI * 2), r = ctx.rng.range(FUMBLE_MIN, FUMBLE_MAX);
    it.props.carriedBy = '';
    it.x = clamp(e.x + Math.cos(a) * r, it.r, w - it.r);
    it.y = clamp(e.y + Math.sin(a) * r, it.r, h - it.r);
  }
  ctx.emit({ type: 'collect.dropped', player: id, data: { count: loot.length } });
  ctx.fx({ kind: 'particles', preset: 'burst', x: e.x, y: e.y });
}

export const collect: BlockDef<CollectParams> = {
  id: 'collect',
  name: 'Collect',
  summary: 'Items pop up; grab them for points, or carry them home to bank (own baskets, carry limits that slow you and make noise, combo bonus for full trips). Golden items, bump-to-steal.',
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
    spawnArea: 'anywhere',
    spawnRadius: 300,
    homeBases: false,
    bankBonus: 0,
    carrySlowdown: 0,
    carryNoise: 0,
    goldenEventKind: '',
    frenzyEventKind: '',
    callout: 'play',
    teamBases: false,
    stealNeedsDash: false,
    knockLoose: false,
    bankLabel: 'Banked!',
  },
  controls: ['joystick'],
  arenaKinds: ['topdown'],
  requiredControls: () => [{ kind: 'joystick', id: '', alt: [{ kind: 'tilt', id: '' }] }],

  setup(ctx) {
    const s = S(ctx);
    ensureAvatars(ctx as BlockCtx<unknown>, 'collect');
    syncGoal(ctx, s);
    syncBases(ctx, s);
    // everyone starts at their own basket
    if (useBases(ctx.params)) {
      const { width: w, height: h } = ctx.world;
      for (const p of ctx.players) {
        const e = ctx.entityOf(p.id), b = bankSpot(ctx, s, p.id);
        if (!e || !b) continue;
        const dx = w / 2 - b.x, dy = h / 2 - b.y, d = len(dx, dy) || 1;
        e.x = b.x + (dx / d) * (b.r * 0.5);
        e.y = b.y + (dy / d) * (b.r * 0.5);
      }
    }
    const n = Math.ceil(ctx.params.maxItems / 2);
    for (let i = 0; i < n; i++) spawnItem(ctx, s);
    s.lastSpawn = 0;
  },

  onInput(ctx, playerId, input) {
    const e = ctx.entityOf(playerId);
    if (!e || e.props.mover !== 'collect') return;
    const s = S(ctx);
    let d = s.intents.get(playerId);
    if (!d) s.intents.set(playerId, (d = { x: 0, y: 0 }));
    inputDir(input, 'joystick', 1.5, d);
  },

  onTimeline(ctx, ev) {
    const s = S(ctx);
    const P = ctx.params;
    const { width: w, height: h } = ctx.world;
    if (P.goldenEventKind !== '' && ev.kind === P.goldenEventKind) {
      // the jackpot lands in the risky middle (next to a guard if there is one)
      const g = ctx.world.ofKind('guard').values().next().value as Entity | undefined;
      const cx = g ? g.x : w / 2, cy = g ? g.y : h / 2;
      const a = ctx.rng.range(0, Math.PI * 2), r = (g ? g.r : 0) + P.itemRadius + 40;
      const it = spawnAt(ctx, s, clamp(cx + Math.cos(a) * r, 40, w - 40), clamp(cy + Math.sin(a) * r, 40, h - 40), true);
      callout(ctx as BlockCtx<unknown>, P.callout, 'golden', undefined, { phase: 'spawn', item: it.id, x: it.x, y: it.y });
      ctx.fx({ kind: 'flash', color: '#ffd84a' });
      ctx.fx({ kind: 'sfx', name: 'score' });
    } else if (P.frenzyEventKind !== '' && ev.kind === P.frenzyEventKind) {
      // fill the field (a little past the cap: it is a frenzy)
      const cap = Math.min(40, P.maxItems + 6);
      while (s.items.length < cap) spawnItem(ctx, s);
      ctx.fx({ kind: 'sfx', name: 'whoosh' });
    }
  },

  update(ctx, dt) {
    const s = S(ctx);
    const P = ctx.params;
    const goal = syncGoal(ctx, s);
    syncBases(ctx, s);
    // items another block removed (or that sank) no longer count against the cap
    s.items = s.items.filter((id) => ctx.world.get(id) !== undefined);

    // spawn on a timer up to maxItems; derived from the last spawn so live tweaks apply at once
    if (ctx.time >= s.lastSpawn + P.spawnEverySec) {
      if (s.items.length < P.maxItems) spawnItem(ctx, s);
      s.lastSpawn = ctx.time;
    }

    // fumbles requested by other blocks (a guard's catch): drop everything once per request
    for (const p of ctx.players) {
      const e = ctx.entityOf(p.id);
      const f = e?.props.fumbleAt;
      if (!e || typeof f !== 'number' || f <= (s.fumbled.get(p.id) ?? -1)) continue;
      s.fumbled.set(p.id, f);
      fumble(ctx, s, p.id, e);
    }

    // bump-to-steal (before movement rewrites velocities). Only the first step of a contact
    // counts, and it consumes the ram mark: holding the stick into someone is one bump.
    const was = s.touching;
    s.touching = new Set();
    const ps = ctx.players;
    for (let i = 0; i < ps.length; i++) {
      const a = ctx.entityOf(ps[i]!.id);
      if (!a) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ctx.entityOf(ps[j]!.id);
        if (!b || len(b.x - a.x, b.y - a.y) > a.r + b.r + TOUCH_SLACK) continue;
        const key = `${ps[i]!.id}|${ps[j]!.id}`;
        s.touching.add(key);
        if (!P.stealOnBump || was.has(key)) continue;
        const thief = rammer(a, b, ctx.time);
        consumeRam(a);
        consumeRam(b);
        if (thief) steal(ctx, s, thief, thief === a ? b : a);
      }
    }

    // pickups (players in join order; the grid is fresh because nothing moved yet).
    // A tumbling (stunned) avatar can't grab anything.
    ctx.world.invalidate();
    for (const p of ctx.players) {
      const e = ctx.entityOf(p.id);
      if (!e || isStunned(ctx as BlockCtx<unknown>, e)) continue;
      let held = P.carryToGoal ? carriedBy(ctx, s, p.id).length : 0;
      for (const it of ctx.world.query(e.x, e.y, e.r)) {
        if (it.kind !== 'item' || it.props.carriedBy !== '' || !s.items.includes(it.id)) continue;
        if (P.carryToGoal && held >= P.carryMax) break;
        pickup(ctx, s, p.id, it);
        held++;
      }
    }

    // carried items trail their carrier; bank at the goal; drop if the carrier is gone;
    // loose items with no floor under them sink
    for (const iid of s.items.slice()) {
      const it = ctx.world.get(iid);
      if (!it) continue;
      if (it.props.carriedBy === '') {
        if (!onFloor(ctx as BlockCtx<unknown>, it.x, it.y)) removeItem(ctx, s, it);
        continue;
      }
      const owner = it.props.carriedBy as string;
      if (!P.carryToGoal) {
        // carry mode switched off live: carried items pay out
        bank(ctx, s, owner, it, [it]);
        continue;
      }
      if (!ctx.entityOf(owner)) it.props.carriedBy = '';
    }
    for (const p of ctx.players) {
      const e = ctx.entityOf(p.id);
      if (!e) continue;
      const loot = P.carryToGoal ? carriedBy(ctx, s, p.id) : [];
      // publish load for movers (speed), guards (noise) and renderers (count)
      e.props.carry = loot.length;
      e.props.loadMul = Math.max(0.2, 1 - P.carrySlowdown * loot.length);
      e.props.noiseMul = 1 + P.carryNoise * loot.length;
      if (!P.carryToGoal) continue;
      const spot = useBases(P) ? bankSpot(ctx, s, p.id) : goal;
      if (spot && loot.length > 0 && len(e.x - spot.x, e.y - spot.y) <= spot.r) {
        bank(ctx, s, p.id, spot, loot);
        e.props.carry = 0;
        e.props.loadMul = 1;
        e.props.noiseMul = 1;
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

    fallbackMove(ctx as BlockCtx<unknown>, 'collect', s.intents, dt);
  },

  bot(ctx, playerId, skill) {
    const s = S(ctx);
    const P = ctx.params;
    const e = ctx.entityOf(playerId);
    if (!e) return { t: 0 };
    const sk = clamp(skill, 0, 1);
    let m = s.bots.get(playerId);
    if (!m) {
      // personality: how greedy a trip is, how much it likes to rob people
      m = { ...botMem(new Map(), playerId), greed: ctx.rng.range(0, 1), aggro: ctx.rng.range(0, 1), huntUntil: 0 };
      s.bots.set(playerId, m);
    }
    const go = (x: number, y: number) => ({ t: 0, axes: steer(ctx as BlockCtx<unknown>, m!, e, x, y, sk) });

    // guards (sneak) are read from their published props: run from a chase, freeze in a stare
    const guards = ctx.world.ofKind('guard');
    for (const g of guards) {
      const d = len(e.x - g.x, e.y - g.y);
      const hunted = g.props.chaseTarget === playerId && (g.props.phase === 'awake' || (g.props.phase === 'waking' && ctx.rng.next() < sk));
      if (hunted) {
        // flee away from the guard, leaning toward home when home is not behind it
        const ax = (e.x - g.x) / (d || 1), ay = (e.y - g.y) / (d || 1);
        const home = bankSpot(ctx, s, playerId);
        let fx = ax, fy = ay;
        if (home) {
          const hx = home.x - e.x, hy = home.y - e.y, hd = len(hx, hy) || 1;
          if ((hx * ax + hy * ay) / hd > -0.2) { fx = ax + (hx / hd) * 1.2; fy = ay + (hy / hd) * 1.2; }
        }
        // slide along walls instead of pinning yourself in a corner
        const { width: w, height: h } = ctx.world;
        if ((e.x < 80 && fx < 0) || (e.x > w - 80 && fx > 0)) fx = 0;
        if ((e.y < 80 && fy < 0) || (e.y > h - 80 && fy > 0)) fy = 0;
        if (fx === 0 && fy === 0) fy = e.y < h / 2 ? 1 : -1;
        return go(e.x + fx * 200, e.y + fy * 200);
      }
      const staring = g.props.visionOn === true && g.props.phase !== 'calm';
      if (staring && d <= (typeof g.props.visionRange === 'number' ? g.props.visionRange : 380) + 60 && ctx.rng.next() < 0.6 + 0.4 * sk) {
        return { t: 0, axes: { x: 0, y: 0 } };
      }
    }

    const free: Entity[] = [];
    for (const iid of s.items) {
      const it = ctx.world.get(iid);
      if (it && it.props.carriedBy === '') free.push(it);
    }
    // loose items next to a hunting guard are bait: avoid them
    const safe = (it: Entity) => {
      for (const g of guards) {
        if ((g.props.phase === 'awake' || g.props.phase === 'waking') && len(it.x - g.x, it.y - g.y) < 150) return false;
      }
      return onFloor(ctx as BlockCtx<unknown>, it.x, it.y, true);
    };

    if (P.carryToGoal) {
      const held = carriedBy(ctx, s, playerId).length;
      const home = useBases(P) ? bankSpot(ctx, s, playerId) : (s.goalId !== undefined ? ctx.world.get(s.goalId) : undefined);
      const hx = home?.x ?? goalPos(ctx).x, hy = home?.y ?? goalPos(ctx).y;
      const homeD = len(hx - e.x, hy - e.y);
      // greedier, better bots fill their hands; everyone runs home when a thief closes in or time runs out
      const want = clamp(Math.round(1 + (P.carryMax - 1) * (0.25 + 0.5 * m.greed + 0.25 * sk)), 1, P.carryMax);
      const topSpeed = (typeof e.props.topSpeed === 'number' ? e.props.topSpeed : 260) * (typeof e.props.loadMul === 'number' ? e.props.loadMul : 1);
      const late = ctx.remaining < homeD / Math.max(60, topSpeed) + 1.5;
      let threatened = false;
      if (P.stealOnBump && held >= 2) {
        for (const p of ctx.players) {
          if (p.id === playerId) continue;
          const o = ctx.entityOf(p.id);
          if (o && !mates(ctx, playerId, p.id) && len(o.x - e.x, o.y - e.y) < 160 && ((o.props.carry as number | undefined) ?? 0) < held) threatened = sk > 0.5;
        }
      }
      if (held === 0 && m.targetId === -1) m.targetId = undefined;
      if (held > 0 && (held >= want || free.filter(safe).length === 0 || m.targetId === -1 || late || threatened)) {
        m.targetId = -1; // committed to banking until the loot is gone
        return go(hx, hy);
      }

      // thieving: intercept a loaded rival nearby (personality + skill)
      if (P.stealOnBump && held < P.carryMax && (s.stealReadyAt.get(playerId) ?? 0) <= ctx.time) {
        let prey = m.prey !== undefined && ctx.time < m.huntUntil ? ctx.entityOf(m.prey) : undefined;
        if (prey && ((prey.props.carry as number) ?? 0) === 0) prey = undefined;
        if (!prey && ctx.time >= m.until) {
          let best = 0;
          for (const p of ctx.players) {
            if (p.id === playerId || (s.immuneUntil.get(p.id) ?? 0) > ctx.time || mates(ctx, playerId, p.id)) continue;
            const o = ctx.entityOf(p.id);
            const c = (o?.props.carry as number | undefined) ?? 0;
            if (!o || c === 0) continue;
            const d = len(o.x - e.x, o.y - e.y);
            const v = (c / (d + 80)) * (0.6 + m.aggro);
            if (d < 380 && v > best) { best = v; prey = o; }
          }
          if (prey && ctx.rng.next() < 0.15 + 0.6 * m.aggro * (0.5 + sk / 2)) {
            m.prey = prey.owner;
            m.huntUntil = ctx.time + 1.5 + 1.5 * sk;
          } else {
            prey = undefined;
          }
        }
        if (prey) {
          // lead the target: aim where it will be
          const lead = 0.15 + 0.35 * sk;
          const f: InputFrame = go(prey.x + prey.vx * lead, prey.y + prey.vy * lead);
          const key = typeof e.props.dashKey === 'string' ? e.props.dashKey : '';
          if (P.stealNeedsDash && key && e.props.dashReady === true && len(prey.x - e.x, prey.y - e.y) < 120 + 40 * sk && ctx.rng.next() < 0.1 + 0.3 * sk) {
            f.buttons = { [key]: true };
          }
          return f;
        }
      }
    }

    let target = m.targetId !== undefined && m.targetId >= 0 ? ctx.world.get(m.targetId) : undefined;
    if (!target || target.props.carriedBy !== '' || ctx.time >= m.until || !safe(target)) {
      target = undefined;
      const pool = free.filter(safe);
      if (pool.length > 0) {
        if (ctx.rng.next() < (1 - sk) * 0.35) {
          target = ctx.rng.pick(pool); // a plausible misjudgement
        } else {
          let best = Infinity;
          for (const it of pool) {
            // skip loot a rival is clearly closer to (good bots only)
            let rivalCloser = false;
            if (sk > 0.6) {
              const mine = len(it.x - e.x, it.y - e.y);
              for (const p of ctx.players) {
                const o = p.id === playerId ? undefined : ctx.entityOf(p.id);
                if (o && len(it.x - o.x, it.y - o.y) < mine * 0.5) { rivalCloser = true; break; }
              }
            }
            const c = (len(it.x - e.x, it.y - e.y) * (rivalCloser ? 2 : 1)) / (it.props.golden ? P.goldenMultiplier * 1.5 : 1);
            if (c < best) { best = c; target = it; }
          }
        }
      }
      m.targetId = target?.id;
      // slower bots take longer to reconsider
      m.until = ctx.time + ctx.rng.range(0.4, 0.8) + (1 - sk) * 0.8;
    }
    if (!target) return { t: 0 };
    return go(target.x, target.y);
  },
};
