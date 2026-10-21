import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { GameSpec } from '@cadabra/spec';
import { BlockRegistry, GameRuntime, type BlockDef, type Player } from '../src/index';

const DT_STEPS = 60; // steps per second

const testScorer: BlockDef<{ points: number }> = {
  id: 'test-scorer',
  name: 'Test Scorer',
  summary: 'Scores while button a is held',
  paramsSchema: z.object({ points: z.number() }),
  defaults: { points: 1 },
  controls: ['button'],
  arenaKinds: ['topdown'],
  setup(ctx) {
    ctx.players.forEach((p, i) => {
      const e = ctx.world.spawn('player', 100 + i * 50 + ctx.rng.range(0, 10), 100, { owner: p.id, r: 20, sprite: 'player' });
      e.props.boost = 1;
    });
  },
  update(ctx, dt) {
    for (const p of ctx.players) {
      const e = ctx.entityOf(p.id);
      if (e) e.x += ((e.props.boost as number) ?? 1) * 10 * dt;
    }
  },
  onInput(ctx, playerId, input) {
    if (input.buttons?.a) ctx.score(playerId, ctx.params.points, 'held a');
    if (input.swipe) ctx.emit({ type: 'swipe', player: playerId, data: { dir: input.swipe } });
    if (input.vote !== undefined) ctx.emit({ type: 'vote', player: playerId, data: { vote: input.vote } });
  },
  bot(_ctx, _id, _skill) {
    return { t: 0, buttons: { a: true } };
  },
  onTimeline(ctx, ev) {
    ctx.emit({ type: 'test-timeline', data: { kind: ev.kind } });
  },
};

function makeSpec(over: Partial<GameSpec> = {}): GameSpec {
  return {
    version: 1,
    id: 'test',
    title: 'Test',
    hook: 'A test game',
    theme: {
      palette: { bg: '#000000', primary: '#111111', accent: '#222222', glow: '#333333', text: '#ffffff' },
      artStyle: 'flat',
      keyArtPrompt: 'test',
      sprites: { player: 'dot' },
      sfxSet: 'arcade',
    },
    arena: { kind: 'topdown', width: 1280, height: 720 },
    teams: 0,
    durationSec: 60,
    blocks: [{ block: 'test-scorer', params: {} }],
    modifiers: [],
    win: { type: 'highScore' },
    timeline: [{ atSec: 30, kind: 'surprise', params: {}, hostLine: 'Surprise!' }],
    comeback: { enabled: true, strength: 0.5 },
    controller: [{ kind: 'button', id: 'a', label: 'A' }],
    host: { intro: 'hi', finale: 'last ten', tutorial: 'hold a' },
    origin: { ingredients: [], wild: false },
    ...over,
  };
}

function makePlayers(n = 2): Player[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, name: `P${i}`, avatar: 'a', isBot: false, connected: true, score: 0,
  }));
}

function makeRuntime(spec = makeSpec(), players = makePlayers(), seed = 42) {
  const reg = new BlockRegistry();
  reg.register(testScorer);
  return new GameRuntime(spec, players, reg, seed);
}

function stepN(rt: GameRuntime, n: number, feed?: (rt: GameRuntime, i: number) => void) {
  for (let i = 0; i < n; i++) {
    feed?.(rt, i);
    rt.step();
  }
}

describe('GameRuntime', () => {
  test('same seed + same inputs => identical snapshots after 600 steps', () => {
    const feed = (rt: GameRuntime, i: number) => {
      rt.input('p0', { t: i * 16, buttons: { a: i % 3 === 0 } });
      rt.input('p1', { t: i * 16, buttons: { a: i % 7 < 3 } });
    };
    const a = makeRuntime();
    const b = makeRuntime();
    stepN(a, 600, feed);
    stepN(b, 600, feed);
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.events).toEqual(b.events);
    // a different seed changes rng-driven setup
    const c = makeRuntime(makeSpec(), makePlayers(), 7);
    stepN(c, 600, feed);
    expect(c.snapshot().entities).not.toEqual(a.snapshot().entities);
  });

  test('timeline event fires once at atSec and emits banner', () => {
    const rt = makeRuntime();
    stepN(rt, 30 * DT_STEPS - 1);
    expect(rt.events.filter((e) => e.type === 'test-timeline')).toHaveLength(0);
    rt.drainFx();
    stepN(rt, 1);
    expect(rt.snapshot().banner).toBe('Surprise!');
    expect(rt.drainFx()).toContainEqual({ kind: 'banner', text: 'Surprise!' });
    stepN(rt, 10 * DT_STEPS);
    expect(rt.events.filter((e) => e.type === 'test-timeline')).toHaveLength(1);
    expect(rt.events.filter((e) => e.type === 'timeline')).toHaveLength(1);
  });

  test('round ends at durationSec with state over', () => {
    const rt = makeRuntime();
    expect(rt.state).toBe('intro');
    stepN(rt, 60 * DT_STEPS - 1);
    expect(rt.state).not.toBe('over');
    stepN(rt, 1);
    expect(rt.state).toBe('over');
    expect(rt.snapshot().remaining).toBe(0);
    const t = rt.time;
    stepN(rt, 10);
    expect(rt.time).toBe(t);
    expect(rt.result().ranking).toHaveLength(2);
  });

  test('finale state in last 10 s', () => {
    const rt = makeRuntime();
    stepN(rt, 1);
    expect(rt.state).toBe('playing');
    stepN(rt, 50 * DT_STEPS - 2);
    expect(rt.state).toBe('playing');
    stepN(rt, 1);
    expect(rt.state).toBe('finale');
    expect(rt.events.filter((e) => e.type === 'finale')).toHaveLength(1);
    stepN(rt, 5 * DT_STEPS);
    expect(rt.events.filter((e) => e.type === 'finale')).toHaveLength(1);
  });

  test('comeback boosts last-place player', () => {
    const rt = makeRuntime();
    stepN(rt, 5 * DT_STEPS, (r, i) => r.input('p0', { t: i, buttons: { a: true } }));
    const snap = rt.snapshot();
    const e0 = snap.entities.find((e) => e.owner === 'p0')!;
    const e1 = snap.entities.find((e) => e.owner === 'p1')!;
    expect(e1.props.boost).toBeCloseTo(1 + 0.15 * 0.5);
    expect(e0.props.boost).toBe(1);
  });

  test('missing input does not stall', () => {
    const rt = makeRuntime(makeSpec(), makePlayers(3));
    // p2 presses once then goes silent; p0 holds a for 10 s; p1 never sends anything
    rt.input('p2', { t: 0, buttons: { a: true } });
    stepN(rt, 10 * DT_STEPS, (r, i) => r.input('p0', { t: i, buttons: { a: true } }));
    expect(rt.time).toBeCloseTo(10);
    const s = rt.snapshot().players;
    expect(s.find((p) => p.id === 'p0')!.score).toBe(600);
    expect(s.find((p) => p.id === 'p1')!.score).toBe(0);
    // stale after 500 ms (30 steps): p2 scores for at most 31 steps, never 600
    const p2 = s.find((p) => p.id === 'p2')!.score;
    expect(p2).toBeGreaterThan(0);
    expect(p2).toBeLessThanOrEqual(31);
  });

  test('applyParams changes behavior next step', () => {
    const rt = makeRuntime();
    const hold = (r: GameRuntime, i: number) => r.input('p0', { t: i, buttons: { a: true } });
    stepN(rt, 1, hold);
    expect(rt.snapshot().players[0]!.score).toBe(1);
    rt.applyParams(0, { points: 5 });
    stepN(rt, 1, hold);
    expect(rt.snapshot().players[0]!.score).toBe(6);
    expect(() => rt.applyParams(0, { points: 'x' })).toThrow(/test-scorer/);
  });

  test('construction errors: unknown block and invalid params', () => {
    expect(() => makeRuntime(makeSpec({ blocks: [{ block: 'nope', params: {} }] }))).toThrow('unknown block: nope');
    expect(() => makeRuntime(makeSpec({ blocks: [{ block: 'test-scorer', params: { points: 'x' } }] }))).toThrow(/test-scorer/);
  });

  test('snapshot is a safe copy', () => {
    const rt = makeRuntime();
    stepN(rt, 1);
    const s = rt.snapshot();
    s.entities[0]!.x = -999;
    s.entities[0]!.tags.add('hacked');
    s.players[0]!.score = 999;
    const s2 = rt.snapshot();
    expect(s2.entities[0]!.x).not.toBe(-999);
    expect(s2.entities[0]!.tags.has('hacked')).toBe(false);
    expect(s2.players[0]!.score).toBe(0);
  });

  test('firstTo ends the round at target and teams alternate', () => {
    const rt = makeRuntime(makeSpec({ win: { type: 'firstTo' }, teams: 2 }));
    stepN(rt, 20, (r, i) => r.input('p1', { t: i, buttons: { a: true } }));
    expect(rt.state).toBe('over');
    const res = rt.result();
    expect(res.ranking[0]!.id).toBe('p1');
    expect(res.ranking.map((p) => p.team)).toEqual([1, 0]);
    expect(res.winnerTeam).toBe(1);
  });

  test('one swipe is delivered exactly once', () => {
    const rt = makeRuntime();
    rt.input('p0', { t: 0, swipe: 'up' });
    stepN(rt, 40);
    expect(rt.events.filter((e) => e.type === 'swipe')).toHaveLength(1);
  });

  test('swipe followed by joystick frame before step is not lost', () => {
    const rt = makeRuntime();
    rt.input('p0', { t: 0, swipe: 'left' });
    rt.input('p0', { t: 1, axes: { x: 1, y: 0 } });
    stepN(rt, 5);
    const sw = rt.events.filter((e) => e.type === 'swipe');
    expect(sw).toHaveLength(1);
    expect(sw[0]!.data).toEqual({ dir: 'left' });
  });

  test('one vote is delivered exactly once, even if followed by a held frame', () => {
    const rt = makeRuntime();
    rt.input('p1', { t: 0, vote: 2 });
    rt.input('p1', { t: 1, buttons: { a: true } });
    stepN(rt, 40);
    const v = rt.events.filter((e) => e.type === 'vote');
    expect(v).toHaveLength(1);
    expect(v[0]!.data).toEqual({ vote: 2 });
    // held state from the later frame still applies (until stale)
    expect(rt.snapshot().players[1]!.score).toBe(31);
  });

  test('runtime does not mutate caller players', () => {
    const players = makePlayers(2);
    players[0]!.score = 5;
    const before = JSON.parse(JSON.stringify(players));
    const rt = makeRuntime(makeSpec({ teams: 2 }), players);
    stepN(rt, 10, (r, i) => r.input('p0', { t: i, buttons: { a: true } }));
    rt.setConnected('p1', false);
    expect(players).toEqual(before);
    const snap = rt.snapshot().players;
    expect(snap[0]!.score).toBe(10); // clones start from 0
    expect(snap[1]!.connected).toBe(false);
    expect(snap.map((p) => p.team)).toEqual([0, 1]);
  });

  test('events getter is a copy and player entities default boost to 1', () => {
    const reg = new BlockRegistry();
    reg.register({ ...testScorer, id: 'bare', setup(ctx) { ctx.world.spawn('player', 0, 0, { owner: 'p0' }); } });
    const rt = new GameRuntime(makeSpec({ blocks: [{ block: 'bare', params: {} }] }), makePlayers(), reg, 1);
    expect(rt.snapshot().entities[0]!.props.boost).toBe(1);
    stepN(rt, 1);
    const ev = rt.events as unknown[];
    const n = ev.length;
    ev.push({});
    expect(rt.events).toHaveLength(n);
  });
});
