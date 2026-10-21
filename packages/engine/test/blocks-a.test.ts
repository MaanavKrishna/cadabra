import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { BlockUse, GameSpec, InputFrame } from '@cadabra/spec';
import { BlockRegistry, GameRuntime, type BlockCtx, type BlockDef, type Entity, type Player } from '../src/index';
import { arenaMove, collect, dodge, race, registerBuiltins } from '../src/blocks/index';

const SPS = 60;

function makeSpec(blocks: BlockUse[], kind: GameSpec['arena']['kind'] = 'topdown', over: Partial<GameSpec> = {}): GameSpec {
  return {
    version: 1,
    id: 'blocks-a',
    title: 'Blocks A',
    hook: 'block test',
    theme: {
      palette: { bg: '#000000', primary: '#111111', accent: '#222222', glow: '#333333', text: '#ffffff' },
      artStyle: 'flat',
      keyArtPrompt: 'test',
      sprites: {},
      sfxSet: 'arcade',
    },
    arena: { kind, width: 1280, height: 720 },
    teams: 0,
    durationSec: 60,
    blocks,
    modifiers: [],
    win: { type: 'highScore' },
    timeline: [{ atSec: 30, kind: 'surprise', params: {}, hostLine: 'Surprise!' }],
    comeback: { enabled: false, strength: 0 },
    controller: [{ kind: 'joystick', id: 'move' }],
    host: { intro: 'hi', finale: 'last ten', tutorial: 'go' },
    origin: { ingredients: [], wild: false },
    ...over,
  };
}

function makePlayers(n: number, isBot = false): Player[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, name: `P${i}`, avatar: 'a', isBot, connected: true, score: 0,
  }));
}

/** A no-op block that hands the test its ctx so tests can stage the world directly. */
function makeProbe() {
  let captured: BlockCtx<unknown> | undefined;
  const def: BlockDef<Record<string, never>> = {
    id: 'probe',
    name: 'Probe',
    summary: 'test only',
    paramsSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
    defaults: {},
    controls: [],
    arenaKinds: ['topdown', 'lanes'],
    setup(ctx) {
      captured = ctx as BlockCtx<unknown>;
    },
    update() {},
    onInput() {},
    bot() {
      return { t: 0 };
    },
  };
  return { def, ctx: () => captured! };
}

function runtime(spec: GameSpec, players: Player[], seed = 1, extra: BlockDef[] = []) {
  const reg = new BlockRegistry();
  registerBuiltins(reg);
  for (const d of extra) reg.register(d);
  return new GameRuntime(spec, players, reg, seed);
}

function playBots(rt: GameRuntime, ids: string[], skill: number, seconds: number) {
  for (let i = 0; i < seconds * SPS && rt.state !== 'over'; i++) {
    for (const id of ids) rt.input(id, rt.botInput(id, skill));
    rt.step();
  }
}

function soloBotScore(blocks: BlockUse[], kind: GameSpec['arena']['kind'] = 'topdown', seed = 3): number {
  const rt = runtime(makeSpec(blocks, kind), makePlayers(1, true), seed);
  playBots(rt, ['p0'], 0.7, 60);
  expect(rt.state).toBe('over');
  return rt.result().ranking[0]!.score;
}

const ALL = [arenaMove, collect, dodge, race] as BlockDef[];

describe('builtins registry', () => {
  test('registerBuiltins registers arena-move, collect, dodge, race', () => {
    const reg = new BlockRegistry();
    registerBuiltins(reg);
    for (const id of ['arena-move', 'collect', 'dodge', 'race']) expect(reg.get(id)?.id).toBe(id);
  });

  test.each(ALL.map((d) => [d.id, d] as const))('%s: all params from defaults validate', (_id, def) => {
    const r = def.paramsSchema.safeParse(def.defaults);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(def.defaults);
    expect(def.name.length).toBeGreaterThan(0);
    expect(def.summary.length).toBeGreaterThan(0);
    expect(def.arenaKinds.length).toBeGreaterThan(0);
  });
});

describe('arena-move', () => {
  test('defaults match the brief', () => {
    expect(arenaMove.defaults.speed).toBe(260);
    expect(arenaMove.paramsSchema.safeParse({ ...arenaMove.defaults, speed: 59 }).success).toBe(false);
    expect(arenaMove.paramsSchema.safeParse({ ...arenaMove.defaults, speed: 601 }).success).toBe(false);
  });

  test('bot at skill 0.7 scores > 0 in 60 s solo (movement for collect)', () => {
    const score = soloBotScore([{ block: 'arena-move', params: {} }, { block: 'collect', params: {} }]);
    expect(score).toBeGreaterThan(0);
  });

  test('spawns exactly one avatar per player, even composed with collect and dodge', () => {
    const rt = runtime(
      makeSpec([{ block: 'collect', params: {} }, { block: 'arena-move', params: {} }, { block: 'dodge', params: {} }]),
      makePlayers(3),
    );
    const avatars = rt.snapshot().entities.filter((e) => e.kind === 'player');
    expect(avatars.map((e) => e.owner).sort()).toEqual(['p0', 'p1', 'p2']);
    for (const a of avatars) expect(a.sprite).toBe(`avatar:${a.owner}`);
  });

  test('tilt input moves like joystick', () => {
    const run = (input: 'joystick' | 'tilt', frame: (i: number) => InputFrame) => {
      const rt = runtime(makeSpec([{ block: 'arena-move', params: { input } }]), makePlayers(1));
      const start = rt.snapshot().entities.find((e) => e.owner === 'p0')!;
      for (let i = 0; i < 30; i++) {
        rt.input('p0', frame(i));
        rt.step();
      }
      const end = rt.snapshot().entities.find((e) => e.owner === 'p0')!;
      return { dx: end.x - start.x, dy: end.y - start.y };
    };
    const joy = run('joystick', (i) => ({ t: i, axes: { x: 1, y: 0 } }));
    const tilt = run('tilt', (i) => ({ t: i, tilt: { x: 1, y: 0 } }));
    expect(joy.dx).toBeGreaterThan(50);
    expect(tilt.dx).toBeCloseTo(joy.dx, 5);
    expect(tilt.dy).toBeCloseTo(joy.dy, 5);
  });

  test('stays inside the arena and dash emits arena.dash with juice', () => {
    const rt = runtime(makeSpec([{ block: 'arena-move', params: {} }]), makePlayers(1));
    const fx = [];
    for (let i = 0; i < 4 * SPS; i++) {
      rt.input('p0', { t: i, axes: { x: -1, y: -1 }, buttons: { dash: i % 30 < 2 } });
      rt.step();
      fx.push(...rt.drainFx());
    }
    const e = rt.snapshot().entities.find((x) => x.owner === 'p0')!;
    expect(e.x).toBeGreaterThanOrEqual(e.r);
    expect(e.y).toBeGreaterThanOrEqual(e.r);
    expect(rt.events.filter((ev) => ev.type === 'arena.dash').length).toBeGreaterThan(0);
    expect(fx).toContainEqual({ kind: 'sfx', name: 'whoosh' });
  });
});

describe('collect', () => {
  test('bot at skill 0.7 scores > 0 in 60 s solo', () => {
    expect(soloBotScore([{ block: 'collect', params: {} }])).toBeGreaterThan(0);
  });

  test('bot at skill 0.7 scores > 0 in carry-to-goal mode', () => {
    expect(
      soloBotScore([{ block: 'arena-move', params: {} }, { block: 'collect', params: { carryToGoal: true } }]),
    ).toBeGreaterThan(0);
  });

  test('pickup scores, emits collect.picked and juice', () => {
    const probe = makeProbe();
    const rt = runtime(
      makeSpec([{ block: 'collect', params: { spawnEverySec: 999, maxItems: 1 } }, { block: 'probe', params: {} }]),
      makePlayers(1), 1, [probe.def],
    );
    const ctx = probe.ctx();
    const item = ctx.world.byKind('item')[0]!;
    const av = ctx.entityOf('p0')!;
    av.x = item.x;
    av.y = item.y;
    rt.step();
    expect(rt.snapshot().players[0]!.score).toBeGreaterThan(0);
    expect(rt.events.some((e) => e.type === 'collect.picked' && e.player === 'p0')).toBe(true);
    const fx = rt.drainFx();
    expect(fx.some((f) => f.kind === 'particles')).toBe(true);
    expect(fx.some((f) => f.kind === 'sfx')).toBe(true);
  });

  test('stealOnBump moves carried item', () => {
    const probe = makeProbe();
    const rt = runtime(
      makeSpec([
        { block: 'collect', params: { carryToGoal: true, stealOnBump: true, spawnEverySec: 999, maxItems: 1, goldenChance: 0 } },
        { block: 'probe', params: {} },
      ]),
      makePlayers(2), 1, [probe.def],
    );
    const ctx = probe.ctx();
    const item = ctx.world.byKind('item')[0]!;
    const a = ctx.entityOf('p0')!;
    const b = ctx.entityOf('p1')!;
    // p1 picks the item up
    b.x = item.x; b.y = item.y; b.vx = 0; b.vy = 0;
    a.x = 100; a.y = 100; a.vx = 0; a.vy = 0;
    rt.step();
    expect(ctx.world.get(item.id)!.props.carriedBy).toBe('p1');
    // p0 rams p1
    a.x = b.x - (a.r + b.r) + 2; a.y = b.y; a.vx = 400; a.vy = 0;
    rt.step();
    expect(ctx.world.get(item.id)!.props.carriedBy).toBe('p0');
    const stolen = rt.events.filter((e) => e.type === 'collect.stolen');
    expect(stolen).toHaveLength(1);
    expect(stolen[0]!.player).toBe('p0');
    expect(stolen[0]!.data).toMatchObject({ from: 'p1' });
    const fx = rt.drainFx();
    expect(fx.some((f) => f.kind === 'shake')).toBe(true);
    // break contact, then ram back inside the cooldown: no steal
    b.x = a.x - 300; b.vx = 0; a.vx = 0;
    rt.step();
    b.x = a.x - (a.r + b.r) + 2; b.y = a.y; b.vx = 400; a.vx = 0;
    rt.step();
    expect(ctx.world.get(item.id)!.props.carriedBy).toBe('p0');
    // holding contact past the cooldown is still one bump: no repeat steal
    for (let i = 0; i < 2 * SPS; i++) {
      b.x = a.x - (a.r + b.r) + 2; b.y = a.y; b.vx = 400; a.vx = 0;
      rt.step();
    }
    expect(ctx.world.get(item.id)!.props.carriedBy).toBe('p0');
    expect(rt.events.filter((e) => e.type === 'collect.stolen')).toHaveLength(1);
  });

  test('stealCooldownSec below 0.3 is rejected', () => {
    expect(collect.paramsSchema.safeParse({ ...collect.defaults, stealCooldownSec: 0.2 }).success).toBe(false);
  });

  test('live applyParams: faster spawnEverySec takes effect within 1 s', () => {
    const rt = runtime(makeSpec([{ block: 'collect', params: { spawnEverySec: 999, maxItems: 20 } }]), makePlayers(1));
    const items = () => rt.snapshot().entities.filter((e) => e.kind === 'item').length;
    for (let i = 0; i < 2 * SPS; i++) rt.step();
    const before = items();
    rt.applyParams(0, { spawnEverySec: 0.2 });
    for (let i = 0; i < SPS; i++) rt.step();
    expect(items()).toBeGreaterThanOrEqual(before + 4);
  });

  test('carried items bank at the goal', () => {
    const probe = makeProbe();
    const rt = runtime(
      makeSpec([
        { block: 'collect', params: { carryToGoal: true, spawnEverySec: 999, maxItems: 1, goldenChance: 0, pointsPerItem: 2 } },
        { block: 'probe', params: {} },
      ]),
      makePlayers(1), 1, [probe.def],
    );
    const ctx = probe.ctx();
    const item = ctx.world.byKind('item')[0]!;
    const goal = ctx.world.byKind('goal')[0]!;
    const a = ctx.entityOf('p0')!;
    a.x = item.x; a.y = item.y;
    rt.step();
    expect(rt.snapshot().players[0]!.score).toBe(0);
    a.x = goal.x; a.y = goal.y;
    rt.step();
    expect(rt.snapshot().players[0]!.score).toBe(2);
    expect(ctx.world.get(item.id)).toBeUndefined();
  });
});

describe('dodge', () => {
  test('bot at skill 0.7 scores > 0 in 60 s solo', () => {
    expect(soloBotScore([{ block: 'dodge', params: {} }])).toBeGreaterThan(0);
    expect(soloBotScore([{ block: 'arena-move', params: {} }, { block: 'dodge', params: { pattern: 'chase' } }])).toBeGreaterThan(0);
  });

  test('telegraphMs below 400 is rejected', () => {
    expect(dodge.paramsSchema.safeParse({ ...dodge.defaults, telegraphMs: 399 }).success).toBe(false);
    expect(dodge.defaults.telegraphMs).toBeGreaterThanOrEqual(400);
  });

  test.each(['rain', 'sweep', 'chase', 'ring'] as const)('no hazard hits within telegraphMs of spawn (%s)', (pattern) => {
    const telegraphMs = 600;
    const probe = makeProbe();
    const rt = runtime(
      makeSpec([
        { block: 'dodge', params: { pattern, telegraphMs, startRate: 4, rampPerSec: 0.2, onHit: 'stun' } },
        { block: 'probe', params: {} },
      ]),
      makePlayers(4), 9, [probe.def],
    );
    const ctx = probe.ctx();
    const born = new Map<number, number>();
    let hits = 0;
    let seen = 0;
    for (let i = 0; i < 30 * SPS; i++) {
      // players stand still: worst case for fairness
      rt.step();
      const t = rt.time;
      for (const h of ctx.world.byKind('hazard')) {
        if (!born.has(h.id)) born.set(h.id, t);
        if (h.props.armed) expect(t - born.get(h.id)! + 1e-9).toBeGreaterThanOrEqual(telegraphMs / 1000 - 1 / SPS);
      }
      seen = born.size;
    }
    for (const ev of rt.events.filter((e) => e.type === 'dodge.hit')) {
      hits++;
      const id = ev.data!.hazard as number;
      expect(born.has(id)).toBe(true);
      expect(ev.t - born.get(id)! + 1e-9).toBeGreaterThanOrEqual(telegraphMs / 1000 - 1 / SPS);
    }
    expect(seen).toBeGreaterThan(10);
    if (pattern === 'chase' || pattern === 'rain') expect(hits).toBeGreaterThan(0);
  });

  test('hit emits dodge.hit with shake and applies onHit eliminate', () => {
    const rt = runtime(
      makeSpec([{ block: 'dodge', params: { pattern: 'chase', startRate: 5, onHit: 'eliminate' } }], 'topdown', {
        win: { type: 'lastStanding' },
      }),
      makePlayers(2),
    );
    const fx = [];
    for (let i = 0; i < 40 * SPS && rt.state !== 'over'; i++) {
      rt.step();
      fx.push(...rt.drainFx());
    }
    expect(rt.events.some((e) => e.type === 'dodge.hit')).toBe(true);
    expect(rt.events.some((e) => e.type === 'eliminated')).toBe(true);
    expect(fx.some((f) => f.kind === 'shake')).toBe(true);
    expect(fx).toContainEqual({ kind: 'sfx', name: 'hit' });
  });
});

describe('race', () => {
  test('bot at skill 0.7 scores > 0 in 60 s solo', () => {
    expect(soloBotScore([{ block: 'race', params: {} }], 'lanes')).toBeGreaterThan(0);
    expect(soloBotScore([{ block: 'race', params: { relay: true, mashToRun: false } }], 'lanes')).toBeGreaterThan(0);
  });

  test('relay requires baton pass to advance runner 2', () => {
    const rt = runtime(
      makeSpec([{ block: 'race', params: { relay: true, mashToRun: false, obstacleDensity: 0, boostPads: 0 } }], 'lanes'),
      makePlayers(1),
    );
    const trackLength = race.defaults.trackLength;
    const me = () => rt.snapshot().entities.find((e) => e.kind === 'player' && e.owner === 'p0')!;
    for (let i = 0; i < 20 * SPS; i++) {
      rt.input('p0', { t: i, buttons: { run: true } });
      rt.step();
    }
    // runner 1 is parked at the handoff: runner 2 has not moved without the baton
    expect(me().props.leg).toBe(1);
    expect(me().props.progress as number).toBeLessThanOrEqual(trackLength / 2);
    expect(me().props.progress as number).toBeGreaterThan(trackLength / 2 - 50);
    expect(rt.events.some((e) => e.type === 'race.batonPass')).toBe(false);

    rt.input('p0', { t: 9999, buttons: { run: true, pass: true } });
    rt.step();
    for (let i = 0; i < 2 * SPS; i++) {
      rt.input('p0', { t: 10000 + i, buttons: { run: true } });
      rt.step();
    }
    expect(rt.events.some((e) => e.type === 'race.batonPass' && e.player === 'p0')).toBe(true);
    expect(me().props.leg).toBe(2);
    expect(me().props.progress as number).toBeGreaterThan(trackLength / 2 + 100);
  });

  test('lap completion emits race.lapLead and race.finish with juice', () => {
    const rt = runtime(makeSpec([{ block: 'race', params: { mashToRun: false, obstacleDensity: 0, laps: 1 } }], 'lanes'), makePlayers(2));
    const fx = [];
    for (let i = 0; i < 40 * SPS; i++) {
      rt.input('p0', { t: i, buttons: { run: true } });
      rt.step();
      fx.push(...rt.drainFx());
    }
    expect(rt.events.some((e) => e.type === 'race.lapLead' && e.player === 'p0')).toBe(true);
    expect(rt.events.some((e) => e.type === 'race.finish' && e.player === 'p0')).toBe(true);
    expect(rt.result().ranking[0]!.id).toBe('p0');
    expect(fx.some((f) => f.kind === 'particles')).toBe(true);
  });

  test('obstacle layout is identical across lanes (fair)', () => {
    const rt = runtime(makeSpec([{ block: 'race', params: { obstacleDensity: 0.6, laneCount: 4 } }], 'lanes'), makePlayers(4));
    const obs = rt.snapshot().entities.filter((e) => e.kind === 'obstacle');
    expect(obs.length).toBeGreaterThan(0);
    const byLane = new Map<number, number[]>();
    for (const o of obs) {
      const l = o.props.lane as number;
      byLane.set(l, [...(byLane.get(l) ?? []), o.props.at as number].sort((a, b) => a - b));
    }
    const layouts = [...byLane.values()];
    expect(layouts).toHaveLength(4);
    for (const l of layouts) expect(l).toEqual(layouts[0]);
  });
});

describe('composition', () => {
  test.each([
    ['topdown', [{ block: 'arena-move', params: {} }, { block: 'collect', params: { carryToGoal: true } }, { block: 'dodge', params: { pattern: 'ring' } }]],
    ['lanes', [{ block: 'race', params: { relay: true } }]],
  ] as const)('same seed + bots => identical runs (%s)', (kind, blocks) => {
    const once = () => {
      const rt = runtime(makeSpec(blocks as unknown as BlockUse[], kind), makePlayers(3, true), 11);
      playBots(rt, ['p0', 'p1', 'p2'], 0.7, 20);
      return { snap: rt.snapshot(), events: rt.events };
    };
    const a = once();
    const b = once();
    expect(a.snap).toEqual(b.snap);
    expect(a.events).toEqual(b.events);
  });
});

// ---------- fairness geometry (fix round 1) ----------

const REACT = 0.2; // reaction allowance the checks demand on top of pure travel time

/** Seconds to cover `d` px from rest with top speed v and acceleration a, plus reaction. */
function reach(d: number, v: number, a: number): number {
  return d <= 0 ? 0 : REACT + v / (2 * a) + d / v;
}

/**
 * Runs a sweep round with stationary players and checks every wall as it appears:
 * from every avatar position on the start edge (the worst case: impact = telegraph), a
 * gap corridor is reachable before impact; a concurrent wall comes from the same edge,
 * late enough that crossing the whole arena between the two impacts is possible.
 */
function checkSweepFairness(dodgeParams: Record<string, unknown>, moveParams: Record<string, unknown>, seed = 5) {
  const probe = makeProbe();
  const rt = runtime(
    makeSpec([
      { block: 'arena-move', params: moveParams },
      { block: 'dodge', params: { pattern: 'sweep', startRate: 6, rampPerSec: 0.2, ...dodgeParams } },
      { block: 'probe', params: {} },
    ]),
    makePlayers(2), seed, [probe.def],
  );
  const ctx = probe.ctx();
  const W = 1280, H = 720;
  const v = (moveParams.speed as number | undefined) ?? arenaMove.defaults.speed;
  const acc = (moveParams.accel as number | undefined) ?? arenaMove.defaults.accel;
  const R = 22 * ((moveParams.avatarScale as number | undefined) ?? 1);
  const seen = new Set<number>();
  const walls: { group: number; edge: string; armAt: number }[] = [];
  let checked = 0;
  for (let i = 0; i < 60 * SPS && rt.state !== 'over'; i++) {
    rt.step();
    const groups = new Map<number, typeof hz>();
    const hz = ctx.world.byKind('hazard').filter((h) => h.props.pattern === 'sweep');
    for (const h of hz) {
      const g = h.props.group as number;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(h);
    }
    for (const [g, hs] of groups) {
      if (seen.has(g)) continue;
      seen.add(g);
      const r = hs[0]!.r;
      const axis = hs.every((h) => Math.abs(h.x - hs[0]!.x) < 1e-6) ? 'x' : 'y';
      const span = axis === 'x' ? H : W;
      const along = axis === 'x' ? hs[0]!.x : hs[0]!.y;
      const edge = `${axis}${along < span ? '+' : '-'}`.replace(/.$/, along <= r + 1 ? '+' : '-');
      const cross = hs.map((h) => (axis === 'x' ? h.y : h.x)).sort((a, b) => a - b);
      // free intervals for the avatar centre between hazards (strictly clear by 1 px)
      const pad = r + R + 1;
      const free: [number, number][] = [];
      const bounds = [-Infinity, ...cross, Infinity];
      for (let k = 1; k < bounds.length; k++) {
        const lo = Math.max(R, bounds[k - 1]! + pad), hi = Math.min(span - R, bounds[k]! - pad);
        if (hi >= lo) free.push([lo, hi]);
      }
      expect(free.length).toBeGreaterThan(0);
      const tele = (hs[0]!.props.armAt as number) - (rt.time - 1 / SPS);
      for (let p = R; p <= span - R; p += 4) {
        let d = Infinity;
        for (const [lo, hi] of free) d = Math.min(d, p < lo ? lo - p : p > hi ? p - hi : 0);
        expect(reach(d, v, acc)).toBeLessThanOrEqual(tele + 1e-6);
      }
      const armAt = hs[0]!.props.armAt as number;
      for (const o of walls) {
        if (!groups.has(o.group)) continue; // already gone
        expect(edge).toBe(o.edge);
        // time between the old wall passing a point and the new one arriving there
        expect((rt.time - 1 / SPS) - o.armAt + tele).toBeGreaterThanOrEqual(reach(Math.max(W, H), v, acc) - 1e-6);
      }
      walls.push({ group: g, edge, armAt });
      checked++;
    }
  }
  return checked;
}

describe('dodge fairness', () => {
  test('sweep at defaults: every avatar position can reach a gap before impact', () => {
    expect(checkSweepFairness({}, {})).toBeGreaterThan(5);
  });

  test('sweep at extreme params (hazardRadius max, avatarScale max, speed min) stays passable', () => {
    expect(checkSweepFairness({ hazardRadius: 80, hazardSpeed: 900 }, { avatarScale: 2.5, speed: 60 })).toBeGreaterThan(2);
  });

  test('skill-1 bot takes at most 1 hit/min on sweep', () => {
    for (const seed of [1, 2, 3]) {
      const rt = runtime(makeSpec([{ block: 'arena-move', params: {} }, { block: 'dodge', params: { pattern: 'sweep' } }]), makePlayers(1, true), seed);
      playBots(rt, ['p0'], 1, 60);
      expect(rt.events.filter((e) => e.type === 'dodge.hit').length).toBeLessThanOrEqual(1);
    }
  });

  test.each([
    ['defaults', {}, {}],
    ['extreme', { hazardRadius: 80 }, { avatarScale: 2.5, speed: 60 }],
  ] as const)('rain is escapable from dead centre (%s)', (_n, dp, mp) => {
    const probe = makeProbe();
    const rt = runtime(
      makeSpec([{ block: 'arena-move', params: mp }, { block: 'dodge', params: { startRate: 5, ...dp } }, { block: 'probe', params: {} }]),
      makePlayers(2), 4, [probe.def],
    );
    const ctx = probe.ctx();
    const v = (mp as { speed?: number }).speed ?? 260;
    const R = 22 * ((mp as { avatarScale?: number }).avatarScale ?? 1);
    const seen = new Set<number>();
    for (let i = 0; i < 20 * SPS; i++) {
      rt.step();
      for (const h of ctx.world.byKind('hazard')) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        const tele = (h.props.armAt as number) - (rt.time - 1 / SPS);
        expect(reach(h.r + R + 1, v, arenaMove.defaults.accel)).toBeLessThanOrEqual(tele + 1e-6);
      }
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  test('stunned avatar cannot be hit again until it can move', () => {
    const stunSec = 3;
    const rt = runtime(
      makeSpec([{ block: 'dodge', params: { startRate: 10, onHit: 'stun', stunSec, invulnSec: 0.3 } }]),
      makePlayers(4), 2,
    );
    for (let i = 0; i < 40 * SPS; i++) rt.step();
    const hits = rt.events.filter((e) => e.type === 'dodge.hit');
    expect(hits.length).toBeGreaterThan(3);
    const last = new Map<string, number>();
    for (const h of hits) {
      const prev = last.get(h.player!);
      if (prev !== undefined) expect(h.t - prev).toBeGreaterThanOrEqual(stunSec + 0.5 - 1e-9);
      last.set(h.player!, h.t);
    }
  });

  test('live applyParams: startRate takes effect within 1 s', () => {
    const rt = runtime(makeSpec([{ block: 'dodge', params: { startRate: 0.1, rampPerSec: 0 } }]), makePlayers(1));
    const hz = () => rt.snapshot().entities.filter((e) => e.kind === 'hazard').length;
    for (let i = 0; i < 2 * SPS; i++) rt.step();
    expect(hz()).toBe(0);
    rt.applyParams(0, { startRate: 10, maxRate: 20 });
    for (let i = 0; i < SPS; i++) rt.step();
    expect(hz()).toBeGreaterThan(3);
  });

  test('timeline: surprise and twist fire waves, other kinds do not', () => {
    const count = (kind: string) => {
      const rt = runtime(
        makeSpec([{ block: 'dodge', params: { startRate: 0.1, rampPerSec: 0 } }], 'topdown', {
          timeline: [{ atSec: 1, kind, params: {}, hostLine: 'Now!' }],
        }),
        makePlayers(1),
      );
      for (let i = 0; i < 1.5 * SPS; i++) rt.step();
      return rt.snapshot().entities.filter((e) => e.kind === 'hazard').length;
    };
    expect(count('surprise')).toBeGreaterThan(0);
    expect(count('twist')).toBeGreaterThan(0);
    expect(count('banner')).toBe(0);
  });
});

describe('race live tweaks', () => {
  test('applyParams laneCount mid-round keeps runners in lanes matching obstacles', () => {
    const rt = runtime(makeSpec([{ block: 'race', params: { mashToRun: false, obstacleDensity: 0.5 } }], 'lanes'), makePlayers(4));
    for (let i = 0; i < 3 * SPS; i++) {
      for (const id of ['p0', 'p1', 'p2', 'p3']) rt.input(id, { t: i, buttons: { run: true } });
      rt.step();
    }
    rt.applyParams(0, { laneCount: 2 });
    rt.step();
    const ents = rt.snapshot().entities;
    const obs = ents.filter((e) => e.kind === 'obstacle');
    expect(new Set(obs.map((o) => o.props.lane))).toEqual(new Set([0, 1]));
    for (const r of ents.filter((e) => e.kind === 'player')) {
      const lane = r.props.lane as number;
      expect(lane).toBeLessThan(2);
      const laneObs = obs.filter((o) => o.props.lane === lane);
      expect(laneObs.length).toBeGreaterThan(0);
      for (const o of laneObs) expect(o.y).toBeCloseTo(r.y, 6);
    }
  });

  test('shrinking trackLength mid-round awards no extra laps', () => {
    const rt = runtime(makeSpec([{ block: 'race', params: { mashToRun: false, obstacleDensity: 0, boostPads: 0 } }], 'lanes'), makePlayers(1));
    const me = () => rt.snapshot().entities.find((e) => e.kind === 'player')!;
    const laps = () => rt.events.filter((e) => e.type === 'score' && (e.data?.reason as string).startsWith('race.lap')).length;
    let i = 0;
    while ((me().props.progress as number) < 3000) {
      rt.input('p0', { t: i++, buttons: { run: true } });
      rt.step();
    }
    expect(me().props.lap).toBe(0);
    const before = laps();
    const frac = (me().props.progress as number) / 4000;
    rt.applyParams(0, { trackLength: 1000 });
    rt.input('p0', { t: i++, buttons: { run: true } });
    rt.step();
    expect(laps()).toBe(before);
    expect(me().props.lap).toBe(0);
    expect((me().props.progress as number) / 1000).toBeGreaterThanOrEqual(frac);
    expect((me().props.progress as number) / 1000).toBeLessThan(frac + 0.02);
  });
});

// ---------- ring + chase fairness (fix round 2) ----------

function segDist(px: number, py: number, sx: number, sy: number, ux: number, uy: number): number {
  const t = Math.max(0, (px - sx) * ux + (py - sy) * uy);
  return Math.hypot(px - (sx + ux * t), py - (sy + uy * t));
}

/**
 * Every ring, as it appears: each avatar has a radial route (straight out along its bearing
 * from the ring centre, possibly zero length) to a point no bullet ray ever touches, and
 * can walk it before the ring arms. Avatars that needed no move are never hit by that ring.
 */
function checkRingFairness(dodgeParams: Record<string, unknown>, moveParams: Record<string, unknown>, nPlayers: number, seed: number) {
  const probe = makeProbe();
  const rt = runtime(
    makeSpec([
      { block: 'arena-move', params: moveParams },
      { block: 'dodge', params: { pattern: 'ring', startRate: 6, rampPerSec: 0.2, ...dodgeParams } },
      { block: 'probe', params: {} },
    ]),
    makePlayers(nPlayers), seed, [probe.def],
  );
  const ctx = probe.ctx();
  const v = (moveParams.speed as number | undefined) ?? arenaMove.defaults.speed;
  const acc = (moveParams.accel as number | undefined) ?? arenaMove.defaults.accel;
  const seen = new Set<number>();
  const groupOf = new Map<number, number>();
  const safeIn = new Map<number, Set<string>>(); // ring group -> players needing no move
  let rings = 0, moved = 0;
  for (let i = 0; i < 40 * SPS && rt.state !== 'over'; i++) {
    rt.step();
    const groups = new Map<number, Entity[]>();
    for (const h of ctx.world.byKind('hazard')) {
      if (h.props.pattern !== 'ring') continue;
      groupOf.set(h.id, h.props.group as number);
      const g = h.props.group as number;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(h);
    }
    for (const [g, hs] of groups) {
      if (seen.has(g)) continue;
      seen.add(g);
      rings++;
      const r = hs[0]!.r;
      const tele = (hs[0]!.props.armAt as number) - (rt.time - 1 / SPS);
      const rays = hs.map((h) => {
        const sp = Math.hypot(h.props.ax as number, h.props.ay as number);
        return { sx: h.x, sy: h.y, ux: (h.props.ax as number) / sp, uy: (h.props.ay as number) / sp };
      });
      const cx = rays[0]!.sx - rays[0]!.ux * 26, cy = rays[0]!.sy - rays[0]!.uy * 26;
      const safe = new Set<string>();
      for (const p of ctx.players) {
        const a = ctx.entityOf(p.id)!;
        const rho = Math.hypot(a.x - cx, a.y - cy);
        const bx = rho > 1e-6 ? (a.x - cx) / rho : 1, by = rho > 1e-6 ? (a.y - cy) / rho : 0;
        let d = 0;
        for (; d <= 1500; d += 2) {
          const qx = a.x + bx * d, qy = a.y + by * d;
          if (rays.every((ry) => segDist(qx, qy, ry.sx, ry.sy, ry.ux, ry.uy) >= r + a.r + 1)) break;
        }
        expect(d).toBeLessThanOrEqual(1500);
        expect(reach(d, v, acc)).toBeLessThanOrEqual(tele + 1e-6);
        if (d === 0) safe.add(p.id);
        else moved++;
      }
      safeIn.set(g, safe);
    }
  }
  for (const ev of rt.events.filter((e) => e.type === 'dodge.hit' && e.data!.pattern === 'ring')) {
    const g = groupOf.get(ev.data!.hazard as number)!;
    expect(safeIn.get(g)!.has(ev.player!)).toBe(false);
  }
  return { rings, moved };
}

describe('dodge ring + chase fairness', () => {
  test('ring at defaults: every avatar can reach a never-hit spot before arming', () => {
    const a = checkRingFairness({}, {}, 4, 7);
    const b = checkRingFairness({}, {}, 8, 3);
    expect(a.rings + b.rings).toBeGreaterThan(10);
  });

  test('ring at extreme params (hazardRadius/hazardSpeed max, avatarScale max, speed/accel min) stays escapable', () => {
    const res = checkRingFairness(
      { hazardRadius: 80, hazardSpeed: 900 },
      { avatarScale: 2.5, speed: 60, accel: 200 },
      6, 5,
    );
    expect(res.rings).toBeGreaterThan(3);
  });

  test('chasers at extreme params stay slower than the slowest avatar', () => {
    const probe = makeProbe();
    const speed = 60;
    const rt = runtime(
      makeSpec([
        { block: 'arena-move', params: { speed, avatarScale: 2.5 } },
        { block: 'dodge', params: { pattern: 'chase', hazardSpeed: 900, startRate: 5 } },
        { block: 'probe', params: {} },
      ]),
      makePlayers(3), 2, [probe.def],
    );
    const ctx = probe.ctx();
    let armed = 0;
    for (let i = 0; i < 20 * SPS; i++) {
      rt.step();
      for (const h of ctx.world.byKind('hazard')) {
        if (!h.props.armed) continue;
        armed++;
        expect(Math.hypot(h.vx, h.vy)).toBeLessThan(speed);
      }
    }
    expect(armed).toBeGreaterThan(0);
  });
});
