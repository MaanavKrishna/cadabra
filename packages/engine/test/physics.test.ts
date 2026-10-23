import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { FALLBACK_SPECS, type BlockUse, type GameSpec, type InputFrame, type WorldSpec } from '@cadabra/spec';
import { BlockRegistry, GameRuntime, playtest, registerBuiltins, worldCatalog, type BlockCtx, type BlockDef, type Player } from '../src/index';
import { benchPhysics } from '../scripts/perf';
import { playRound } from '../scripts/balance';

function makeSpec(blocks: BlockUse[], world?: WorldSpec, over: Partial<GameSpec> = {}): GameSpec {
  const s: GameSpec = {
    version: 1, id: 'phys', title: 'Phys', hook: 'physics test',
    theme: {
      palette: { bg: '#0A0E27', primary: '#00E5FF', accent: '#FF2BD6', glow: '#B6FF3B', text: '#F4F7FF' },
      artStyle: 'neon', keyArtPrompt: 'test', sprites: {}, sfxSet: 'neon',
    },
    arena: { kind: 'topdown', width: 1280, height: 720 },
    teams: 0, durationSec: 60, blocks, modifiers: [], win: { type: 'highScore' },
    timeline: [{ atSec: 59, kind: 'noop', params: {}, hostLine: 'hi' }],
    comeback: { enabled: false, strength: 0 },
    controller: [{ kind: 'joystick', id: 'move' }, { kind: 'button', id: 'dash', label: 'Dash' }],
    host: { intro: 'hi', finale: 'last ten', tutorial: 'go' },
    origin: { ingredients: [], wild: false },
    ...over,
  };
  if (world) s.world = world;
  return s;
}

const players = (n: number): Player[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, avatar: 'a', isBot: false, connected: true, score: 0 }));

function setup(spec: GameSpec, n = 2) {
  let captured: BlockCtx<unknown> | undefined;
  const probe: BlockDef<Record<string, never>> = {
    id: 'probe', name: 'Probe', summary: 'test only',
    paramsSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
    defaults: {}, controls: [], arenaKinds: ['topdown'],
    setup(ctx) { captured = ctx as BlockCtx<unknown>; },
    update() {}, onInput() {}, bot() { return { t: 0 }; },
  };
  const reg = new BlockRegistry();
  registerBuiltins(reg);
  reg.register(probe);
  const rt = new GameRuntime({ ...spec, blocks: [...spec.blocks, { block: 'probe', params: {} }] }, players(n), reg, 1, { finalMultiplier: 1 });
  const ctx = captured!;
  return { rt, ctx, ent: (id: string) => ctx.entityOf(id)! };
}

const steps = (rt: GameRuntime, n: number, inputs: Record<string, InputFrame> = {}) => {
  for (let i = 0; i < n; i++) {
    for (const [id, f] of Object.entries(inputs)) rt.input(id, { ...f, t: Math.round(rt.time * 1000) });
    rt.step();
  }
};
const move = (p: Record<string, unknown> = {}): BlockUse => ({ block: 'arena-move', params: { bounceWalls: true, ...p } });
const park = (ctx: BlockCtx<unknown>, id: string, x: number, y: number) => {
  const e = ctx.entityOf(id)!;
  e.x = x; e.y = y; e.vx = e.vy = 0;
};

describe('physics layer', () => {
  test('off without world / physics blocks; on with world.physics', () => {
    expect(setup(makeSpec([move()])).ctx.physics).toBeUndefined();
    const { ctx } = setup(makeSpec([move()], { physics: { knockback: 2 } }));
    expect(ctx.physics?.params.knockback).toBe(2);
  });

  test('a ball hitting a crate pushes it and makes it spin; snapshots carry angle / av / hitAt / impulse', () => {
    const { rt, ctx } = setup(makeSpec([move()], { physics: { friction: 0.8 } }));
    park(ctx, 'p0', 100, 100); park(ctx, 'p1', 100, 600);
    const crate = ctx.physics!.spawnProp('crate', 640, 360);
    const ball = ctx.physics!.spawnProp('ball', 440, 345);
    ball.vx = 900;
    steps(rt, 40);
    const snap = rt.snapshot().entities.find((e) => e.id === crate.id)!;
    expect(snap.x).toBeGreaterThan(650);
    expect(Math.abs(snap.props.angle as number)).toBeGreaterThan(0.01);
    expect(typeof snap.props.av).toBe('number');
    expect(snap.props.hitAt).toBeGreaterThan(0);
    expect(snap.props.impulse).toBeGreaterThan(0.3);
  });

  test('spin: false keeps bodies from rotating', () => {
    const { rt, ctx } = setup(makeSpec([move()], { physics: { spin: false, friction: 0.8 } }));
    park(ctx, 'p0', 100, 100); park(ctx, 'p1', 100, 600);
    const crate = ctx.physics!.spawnProp('crate', 640, 360);
    const ball = ctx.physics!.spawnProp('ball', 440, 345);
    ball.vx = 900;
    steps(rt, 40);
    expect(crate.props.angle).toBe(0);
  });

  test('low damping (floaty) lets a pushed ball travel much further than high damping', () => {
    const dist = (linearDamping: number) => {
      const { rt, ctx } = setup(makeSpec([move()], { physics: { linearDamping, walls: false } }));
      park(ctx, 'p0', 100, 100); park(ctx, 'p1', 100, 600);
      const b = ctx.physics!.spawnProp('ball', 300, 360, 1, { damping: linearDamping });
      b.vx = 300;
      steps(rt, 60);
      return b.x - 300;
    };
    expect(dist(0.1)).toBeGreaterThan(dist(3) * 1.8);
  });

  test('gravity pulls loose props (a sloped table)', () => {
    const { rt, ctx } = setup(makeSpec([move()], { physics: { gravityY: 600 } }));
    park(ctx, 'p0', 100, 100); park(ctx, 'p1', 1100, 100);
    const b = ctx.physics!.spawnProp('crate', 640, 200);
    steps(rt, 30);
    expect(b.y).toBeGreaterThan(260);
  });

  test('a bumper kicks a player back harder than it arrived, flashes, and emits phys.bumper', () => {
    const { rt, ctx, ent } = setup(makeSpec([move({ friction: 0 })], { physics: { bumperKick: 600 } }));
    park(ctx, 'p1', 100, 600);
    const bump = ctx.physics!.spawnProp('bumper', 640, 360);
    park(ctx, 'p0', 520, 360);
    ent('p0').vx = 250;
    steps(rt, 40);
    expect(ent('p0').vx).toBeLessThan(-250);
    expect(ent('p0').x).toBeLessThan(560);
    expect(bump.props.hitAt).toBeGreaterThan(0);
    expect(rt.events.some((e) => e.type === 'phys.bumper' && e.player === 'p0')).toBe(true);
  });

  test('a dash into a barrel detonates it: explode event (moment detonate), blast flings nearby props, credit to the dasher', () => {
    const { rt, ctx, ent } = setup(makeSpec([move()], { physics: { barrelPower: 900 } }));
    park(ctx, 'p1', 100, 600);
    const barrel = ctx.physics!.spawnProp('barrel', 640, 360, 1, { respawnSec: 2, home: '640,360' });
    const crate = ctx.physics!.spawnProp('crate', 740, 360);
    park(ctx, 'p0', 560, 360);
    steps(rt, 2);
    steps(rt, 20, { p0: { t: 0, axes: { x: 1, y: 0 }, buttons: { dash: true } } });
    const ex = rt.events.find((e) => e.type === 'explode');
    expect(ex?.data?.moment).toBe('detonate');
    expect(ex?.player).toBe('p0');
    expect(ctx.world.get(barrel.id)).toBeUndefined();
    expect(crate.x).toBeGreaterThan(760);
    expect(crate.props.touchedBy).toBe('p0');
    steps(rt, 150);
    expect(ctx.world.byKind('barrel').length).toBe(1);
  });

  test('deterministic: the same seed replays the same physics round', () => {
    const spec = FALLBACK_SPECS.find((s) => s.id === 'fallback-crate-crash')!;
    const a = playRound(spec, 3), b = playRound(spec, 3);
    expect(a).toEqual(b);
  });

  test('perf: 4 players + 40 dynamic bodies step well inside the frame budget', () => {
    const r = benchPhysics(3);
    expect(r.bodies).toBeGreaterThanOrEqual(36);
    // ~0.1–0.2 ms on a laptop; the Fire TV Stick core is ~10–20× slower
    expect(r.meanMs).toBeLessThan(5);
  });

  test('worldCatalog describes every physics field with a default, and the looks', () => {
    const c = worldCatalog();
    const props = (c.schema as { properties: { physics: { properties: Record<string, { description?: string; default?: unknown }> } } }).properties.physics.properties;
    for (const k of ['gravityX', 'gravityY', 'restitution', 'friction', 'linearDamping', 'angularDamping', 'playerMass', 'spin', 'knockback']) {
      expect(props[k]?.description, k).toBeTruthy();
      expect(props[k]?.default, k).toBeDefined();
    }
    expect(c.looks).toEqual(['neon', 'toybox', 'cosmos', 'retro']);
  });
});

describe('ball-sport', () => {
  const ballSpec = (p: Record<string, unknown> = {}) =>
    makeSpec([move(), { block: 'ball-sport', params: { callout: 'rocket', kickoffSec: 0.5, ...p } }], undefined, { teams: 2 });

  test('turns physics on, spawns a ball and two nets (kind goal, sprite net, w/h/side)', () => {
    const { ctx } = setup(ballSpec(), 4);
    expect(ctx.physics).toBeDefined();
    expect(ctx.world.byKind('ball').length).toBe(1);
    const nets = ctx.world.byKind('goal');
    expect(nets.map((g) => g.sprite)).toEqual(['net', 'net']);
    expect(nets.map((g) => g.props.side).sort()).toEqual([-1, 1]);
    expect(nets[0]!.props.h).toBe(260);
  });

  test('ball in the left goal: team 1 scores (last toucher GOAL!, mate ASSIST), goal moment, kickoff reset', () => {
    const { rt, ctx } = setup(ballSpec({ goalPoints: 3, assistPoints: 1 }), 4);
    steps(rt, 40); // past the opening freeze
    const ball = ctx.world.byKind('ball')[0]!;
    // p1 (team 1) touches the ball, then it rolls into the left goal
    for (const p of ['p0', 'p1', 'p2', 'p3']) park(ctx, p, 900, 100 + 150 * Number(p[1]));
    park(ctx, 'p1', 260, 360);
    ball.x = 210; ball.y = 360; ball.vx = 0; ball.vy = 0;
    ctx.entityOf('p1')!.vx = -400;
    steps(rt, 40);
    const goal = rt.events.find((e) => e.type === 'rocket.goal');
    expect(goal?.data?.moment).toBe('goal');
    expect(goal?.data?.team).toBe(1);
    const snap = rt.snapshot().players;
    expect(snap.find((p) => p.id === 'p1')!.score).toBe(3);
    expect(snap.find((p) => p.id === 'p3')!.score).toBe(1);
    expect(rt.events.some((e) => e.type === 'score' && e.data?.reason === 'GOAL!')).toBe(true);
    const b = ctx.world.byKind('ball')[0]!;
    expect(Math.abs(b.x - 640)).toBeLessThan(40);
  });

  test('a dashing player power-shoots the ball', () => {
    const shot = (kickPower: number) => {
      const { rt, ctx } = setup(ballSpec({ kickPower }), 2);
      steps(rt, 40);
      const ball = ctx.world.byKind('ball')[0]!;
      park(ctx, 'p1', 640, 650);
      ball.x = 640; ball.y = 360; ball.vx = ball.vy = 0;
      park(ctx, 'p0', 560, 360);
      steps(rt, 15, { p0: { t: 0, axes: { x: 1, y: 0 }, buttons: { dash: true } } });
      return ball.x;
    };
    expect(shot(1000)).toBeGreaterThan(shot(0) + 40);
  });

  test('keepaway: whoever touched the ball last scores possession points', () => {
    const { rt, ctx } = setup(makeSpec([move(), { block: 'ball-sport', params: { mode: 'keepaway', keepAwayEverySec: 1 } }]), 2);
    expect(ctx.world.byKind('goal').length).toBe(0);
    steps(rt, 40);
    const ball = ctx.world.byKind('ball')[0]!;
    park(ctx, 'p1', 1100, 650);
    ball.x = 640; ball.y = 360; ball.vx = ball.vy = 0;
    park(ctx, 'p0', 590, 360);
    ctx.entityOf('p0')!.vx = 200;
    steps(rt, 200);
    expect(rt.snapshot().players.find((p) => p.id === 'p0')!.score).toBeGreaterThan(0);
  });
});

describe('crate crash', () => {
  const crateSpec = () => makeSpec([move({ crates: true, cratesPerZone: 5, crateRefillSec: 0, callout: 'crate' })]);

  test('every player gets a zone (base, home) stacked with crates; crates are physics boxes', () => {
    const { ctx } = setup(crateSpec(), 3);
    expect(ctx.physics).toBeDefined();
    const zones = ctx.world.byKind('base').filter((b) => b.props.zone === true);
    expect(zones.map((z) => z.owner)).toEqual(['p0', 'p1', 'p2']);
    const crates = ctx.world.byKind('crate');
    expect(crates.length).toBe(15);
    expect(crates.every((c) => c.props.body === 'dynamic' && c.props.shape === 'box')).toBe(true);
  });

  test("knocking a rival's crate out of its zone scores CRATE CRASH! and marks the crate out", () => {
    const { rt, ctx } = setup(crateSpec(), 2);
    const z1 = ctx.world.byKind('base').find((b) => b.owner === 'p1')!;
    const crate = ctx.world.byKind('crate').find((c) => c.owner === 'p1')!;
    crate.props.touchedBy = 'p0';
    crate.props.touchedAt = 0;
    crate.x = z1.x + (z1.props.hw as number) + 30;
    steps(rt, 2);
    expect(crate.props.out).toBe(true);
    expect(rt.events.find((e) => e.type === 'crate.crash')?.player).toBe('p0');
    expect(rt.snapshot().players.find((p) => p.id === 'p0')!.score).toBe(2);
    steps(rt, 60);
    expect(ctx.world.get(crate.id)).toBeUndefined();
  });

  test('tallies pay per standing crate', () => {
    const { rt } = setup(makeSpec([move({ crates: true, cratesPerZone: 3, crateRefillSec: 0, crateTallySec: 3 })]), 2);
    steps(rt, 3 * 60 + 2);
    const sc = rt.snapshot().players.map((p) => p.score);
    expect(sc).toEqual([3, 3]);
  });
});

describe('physical fallbacks', () => {
  test('core rush under physics: dash steals still knock cores loose', () => {
    const r = playRound(FALLBACK_SPECS.find((s) => s.id === 'fallback-core-rush')!, 2);
    expect(r.events['rush.steal'] ?? 0).toBeGreaterThan(0);
  });

  test.each(FALLBACK_SPECS.filter((s) => s.world || s.blocks.some((b) => b.block === 'ball-sport')).map((s) => [s.id, s] as const))(
    '%s passes the strict playtest with 1 human seat + 1–3 bots (2–4 bodies)', (_id, spec) => {
      const reg = new BlockRegistry();
      registerBuiltins(reg);
      for (const n of [2, 3, 4]) expect(playtest(spec, reg, { players: n }).reasons, `${n} seats`).toEqual([]);
    });
});
