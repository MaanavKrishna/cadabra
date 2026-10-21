import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { BlockUse, GameSpec, InputFrame } from '@cadabra/spec';
import { BlockRegistry, GameRuntime, type BlockCtx, type BlockDef, type Player } from '../src/index';
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
    // cooldown: an immediate ram back does not steal it again
    b.x = a.x - (a.r + b.r) + 2; b.y = a.y; b.vx = 400; a.vx = 0;
    rt.step();
    expect(ctx.world.get(item.id)!.props.carriedBy).toBe('p0');
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
