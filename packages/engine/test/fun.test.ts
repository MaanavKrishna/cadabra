import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { FALLBACK_SPECS, parseSpec, type BlockUse, type GameSpec, type InputFrame } from '@cadabra/spec';
import {
  BlockRegistry, GameRuntime, LEAD_THROTTLE_SEC, kitCatalog, playtest, registerBuiltins, type BlockCtx, type BlockDef, type Player,
} from '../src/index';
import { playRound } from '../scripts/balance';

const SPS = 60;

function makeSpec(blocks: BlockUse[], over: Partial<GameSpec> = {}): GameSpec {
  return {
    version: 1, id: 'fun', title: 'Fun', hook: 'fun test',
    theme: {
      palette: { bg: '#000000', primary: '#111111', accent: '#222222', glow: '#333333', text: '#ffffff' },
      artStyle: 'flat', keyArtPrompt: 'test', sprites: {}, sfxSet: 'arcade',
    },
    arena: { kind: 'topdown', width: 1280, height: 720 },
    teams: 0, durationSec: 60, blocks, modifiers: [], win: { type: 'highScore' },
    timeline: [{ atSec: 59, kind: 'noop', params: {}, hostLine: 'hi' }],
    comeback: { enabled: false, strength: 0 },
    controller: [{ kind: 'joystick', id: 'move' }, { kind: 'hold', id: 'tiptoe', label: 'Tiptoe' }, { kind: 'button', id: 'dash', label: 'Dash' }],
    host: { intro: 'hi', finale: 'last ten', tutorial: 'go' },
    origin: { ingredients: [], wild: false },
    ...over,
  };
}

const players = (n: number): Player[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, avatar: 'a', isBot: false, connected: true, score: 0 }));

/** Hands the test its ctx so tests can stage the world. */
function makeProbe() {
  let captured: BlockCtx<unknown> | undefined;
  const def: BlockDef<Record<string, never>> = {
    id: 'probe', name: 'Probe', summary: 'test only',
    paramsSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
    defaults: {}, controls: [], arenaKinds: ['topdown', 'tug'],
    setup(ctx) { captured = ctx as BlockCtx<unknown>; },
    update() {}, onInput() {}, bot() { return { t: 0 }; },
  };
  return { def, ctx: () => captured! };
}

function runtime(spec: GameSpec, ps: Player[], seed = 1, extra: BlockDef[] = []) {
  const reg = new BlockRegistry();
  registerBuiltins(reg);
  for (const d of extra) reg.register(d);
  return new GameRuntime(spec, ps, reg, seed);
}

const evs = (rt: GameRuntime, type: string) => rt.events.filter((e) => e.type === type);
const scoreOf = (rt: GameRuntime, id: string) => rt.snapshot().players.find((p) => p.id === id)!.score;

// ---------- runtime: final 10 double points, lead changes ----------

const scorer: BlockDef<{ who: string }> = {
  id: 'scorer', name: 'Scorer', summary: 'test: button a scores 1, b scores -1',
  paramsSchema: z.object({ who: z.string() }), defaults: { who: '' }, controls: ['button'], arenaKinds: ['topdown'],
  setup() {}, update() {}, bot() { return { t: 0 }; },
  onInput(ctx, id, input) {
    if (input.buttons?.a) ctx.score(id, 1, 'A');
    if (input.buttons?.b) ctx.score(id, -1, 'B');
  },
};

describe('runtime: finale and lead changes', () => {
  test('final 10 s: positive points double, penalties do not; final.start fires once', () => {
    const rt = runtime(makeSpec([{ block: 'scorer', params: {} }]), players(1), 1, [scorer as BlockDef]);
    const press = (k: string) => { rt.input('p0', { t: 0, buttons: { [k]: true } }); rt.step(); rt.input('p0', { t: 0, buttons: {} }); };
    press('a');
    expect(scoreOf(rt, 'p0')).toBe(1);
    while (rt.state !== 'finale') rt.step();
    expect(evs(rt, 'final.start')).toHaveLength(1);
    expect(evs(rt, 'final.start')[0]!.data).toMatchObject({ multiplier: 2 });
    press('a');
    expect(scoreOf(rt, 'p0')).toBe(3);
    const last = evs(rt, 'score').at(-1)!;
    expect(last.data).toMatchObject({ delta: 2, base: 1, mult: 2, reason: 'A' });
    press('b');
    expect(scoreOf(rt, 'p0')).toBe(2);
    while ((rt.state as string) !== 'over') rt.step();
    expect(evs(rt, 'final.start')).toHaveLength(1);
  });

  test('finalMultiplier 1 turns doubling off', () => {
    const reg = new BlockRegistry();
    reg.register(scorer as BlockDef);
    const rt = new GameRuntime(makeSpec([{ block: 'scorer', params: {} }]), players(1), reg, 1, { finalMultiplier: 1 });
    while (rt.state !== 'finale') rt.step();
    rt.input('p0', { t: 0, buttons: { a: true } });
    rt.step();
    expect(scoreOf(rt, 'p0')).toBe(1);
  });

  test('lead.change is emitted on a new unique leader and throttled to one per 6 s', () => {
    const rt = runtime(makeSpec([{ block: 'scorer', params: {} }]), players(2), 1, [scorer as BlockDef]);
    const tap = (id: string) => { rt.input(id, { t: 0, buttons: { a: true } }); rt.step(); rt.input(id, { t: 0, buttons: {} }); rt.step(); };
    tap('p0');
    expect(evs(rt, 'lead.change')).toHaveLength(1);
    expect(evs(rt, 'lead.change')[0]).toMatchObject({ player: 'p0', data: { prev: null } });
    tap('p1'); // tie: no leader, no event
    tap('p1'); // p1 leads, but inside the throttle window
    expect(evs(rt, 'lead.change')).toHaveLength(1);
    expect(rt.leadChanges).toBe(1);
    while (rt.time < LEAD_THROTTLE_SEC + 0.5) rt.step();
    expect(evs(rt, 'lead.change')).toHaveLength(2);
    expect(evs(rt, 'lead.change')[1]).toMatchObject({ player: 'p1', data: { prev: 'p0' } });
  });
});

// ---------- heist: carry, noise, bases, chase ----------

const heistBlocks = (sneak: Record<string, unknown> = {}, collect: Record<string, unknown> = {}): BlockUse[] => [
  { block: 'sneak', params: { onWake: 'chase', daringPoints: 0, callout: 'heist', ...sneak } },
  {
    block: 'collect',
    params: {
      carryToGoal: true, homeBases: true, carryMax: 3, bankBonus: 1, carrySlowdown: 0.12, carryNoise: 0.6,
      spawnEverySec: 999, maxItems: 6, goldenChance: 0, spawnArea: 'centre', spawnRadius: 250, callout: 'heist', ...collect,
    },
  },
  { block: 'probe', params: {} },
];

describe('heist mechanics', () => {
  test('every player gets an own basket (kind base, owner, props.home) and starts at it', () => {
    const probe = makeProbe();
    runtime(makeSpec(heistBlocks()), players(4), 1, [probe.def]);
    const ctx = probe.ctx();
    const bases = ctx.world.byKind('base');
    expect(bases.map((b) => b.owner).sort()).toEqual(['p0', 'p1', 'p2', 'p3']);
    for (const b of bases) {
      expect(b.props.home).toBe(true);
      const e = ctx.entityOf(b.owner!)!;
      expect(Math.hypot(e.x - b.x, e.y - b.y)).toBeLessThan(b.r);
    }
    // loot spawns in the middle (around the bear), not at the edges
    for (const it of ctx.world.byKind('item')) expect(Math.hypot(it.x - 640, it.y - 360)).toBeLessThanOrEqual(251);
  });

  test('carrying slows you down and makes you louder', () => {
    const probe = makeProbe();
    const rt = runtime(makeSpec(heistBlocks()), players(1), 1, [probe.def]);
    const ctx = probe.ctx();
    const e = ctx.entityOf('p0')!;
    const items = ctx.world.byKind('item');
    for (const it of items) { e.x = it.x; e.y = it.y; rt.step(); }
    expect(e.props.carry).toBe(3);
    expect(e.props.loadMul as number).toBeCloseTo(1 - 0.36, 5);
    expect(e.props.noiseMul as number).toBeCloseTo(1 + 1.8, 5);
    // run flat out right: loaded speed is 64% of 260
    e.x = 300; e.y = 600;
    rt.input('p0', { t: 0, axes: { x: 1, y: 0 } });
    rt.step();
    expect(Math.hypot(e.vx, e.vy)).toBeCloseTo(260 * 0.64, 0);
    rt.step();
    expect(e.props.loud as number).toBeGreaterThan(0.9);
  });

  test('loaded runners wake the bear much faster than empty-handed ones', () => {
    const wakeTime = (carry: boolean) => {
      const probe = makeProbe();
      const rt = runtime(makeSpec(heistBlocks()), players(1), 1, [probe.def]);
      const ctx = probe.ctx();
      const e = ctx.entityOf('p0')!;
      if (carry) for (const it of ctx.world.byKind('item')) { e.x = it.x; e.y = it.y; rt.step(); }
      else for (const it of ctx.world.byKind('item')) ctx.world.remove(it.id);
      const t0 = rt.time;
      // pace back and forth near the bear (beside it, never touching)
      for (let i = 0; i < 20 * SPS && evs(rt, 'sneak.waking').length === 0; i++) {
        e.x = 640 + 120; e.y = 360 + (i % 120 < 60 ? -40 : 40);
        rt.input('p0', { t: i, axes: { x: 0, y: i % 120 < 60 ? 1 : -1 } });
        rt.step();
      }
      return rt.time - t0;
    };
    expect(wakeTime(true)).toBeLessThan(wakeTime(false) * 0.6);
  });

  test('banking: only at your own basket, with a combo bonus for full trips (1, 3, 6)', () => {
    const probe = makeProbe();
    const rt = runtime(makeSpec(heistBlocks()), players(2), 1, [probe.def]);
    const ctx = probe.ctx();
    const e = ctx.entityOf('p0')!;
    for (const it of ctx.world.byKind('item')) { e.x = it.x; e.y = it.y; rt.step(); }
    const mine = ctx.world.byKind('base').find((b) => b.owner === 'p0')!;
    const theirs = ctx.world.byKind('base').find((b) => b.owner === 'p1')!;
    e.x = theirs.x; e.y = theirs.y;
    rt.step();
    expect(scoreOf(rt, 'p0')).toBe(0);
    e.x = mine.x; e.y = mine.y;
    rt.step();
    expect(scoreOf(rt, 'p0')).toBe(6);
    expect(evs(rt, 'heist.bank')[0]).toMatchObject({ player: 'p0', data: { count: 3, points: 6, moment: 'bank' } });
    expect(evs(rt, 'score').at(-1)!.data!.reason).toBe('Banked!');
  });

  test('bumping a carrier steals one and knocks them tumbling (heist.steal)', () => {
    const probe = makeProbe();
    const rt = runtime(makeSpec(heistBlocks()), players(2), 1, [probe.def]);
    const ctx = probe.ctx();
    const a = ctx.entityOf('p0')!, b = ctx.entityOf('p1')!;
    for (const it of ctx.world.byKind('item').slice(0, 2)) { b.x = it.x; b.y = it.y; rt.step(); }
    expect(b.props.carry).toBe(2);
    a.x = b.x - (a.r + b.r) + 2; a.y = b.y; b.vx = b.vy = 0;
    rt.input('p0', { t: 0, axes: { x: 1, y: 0 } });
    rt.step();
    expect(evs(rt, 'heist.steal')).toHaveLength(1);
    expect(a.props.carry).toBe(1);
    expect(b.props.carry).toBe(1);
    expect(b.props.stunUntil as number).toBeGreaterThan(rt.time);
  });

  test('woken bear chases the loudest player; a catch makes them drop everything', () => {
    const probe = makeProbe();
    const rt = runtime(makeSpec(heistBlocks({ chaseSpeed: 400, chaseSec: 5 })), players(2), 1, [probe.def]);
    const ctx = probe.ctx();
    const loud = ctx.entityOf('p0')!, quiet = ctx.entityOf('p1')!;
    for (const it of ctx.world.byKind('item')) { loud.x = it.x; loud.y = it.y; rt.step(); }
    expect(loud.props.carry).toBe(3);
    // p0 stomps around next to the bear while p1 stands still far away
    for (let i = 0; i < 20 * SPS && evs(rt, 'heist.chase.start').length === 0; i++) {
      loud.x = 760; loud.y = 360 + (i % 120 < 60 ? -40 : 40);
      rt.input('p0', { t: i, axes: { x: 0, y: i % 120 < 60 ? 1 : -1 } });
      rt.step();
    }
    const start = evs(rt, 'heist.chase.start');
    expect(start).toHaveLength(1);
    expect(start[0]!.player).toBe('p0');
    const bear = ctx.world.byKind('guard')[0]!;
    expect(bear.props.chaseTarget).toBe('p0');
    expect(bear.props.chasing).toBe(true);
    // p0 tries to run but the bear is faster
    for (let i = 0; i < 4 * SPS && evs(rt, 'heist.caught').length === 0; i++) {
      rt.input('p0', { t: i, axes: { x: 1, y: 0 } });
      rt.step();
    }
    expect(evs(rt, 'heist.caught')).toHaveLength(1);
    expect(evs(rt, 'heist.caught')[0]).toMatchObject({ player: 'p0', data: { dropped: 3 } });
    rt.step();
    expect(loud.props.carry).toBe(0);
    expect(ctx.world.byKind('item').filter((i) => i.props.carriedBy === '')).toHaveLength(3);
    expect(loud.props.stunUntil as number).toBeGreaterThan(rt.time);
    expect(quiet.props.carry ?? 0).toBe(0);
    // it gives up, plods home and falls asleep again
    for (let i = 0; i < 10 * SPS; i++) rt.step();
    expect(bear.props.phase).toBe('calm');
    expect(Math.hypot(bear.x - 640, bear.y - 360)).toBeLessThan(3);
  });

  test('woke the bear costs points with a readable reason', () => {
    const rt = runtime(makeSpec(heistBlocks()), players(1), 1, [makeProbe().def]);
    (rt as unknown as { players: Player[] }).players[0]!.score = 5;
    const e = rt.snapshot().entities.find((x) => x.owner === 'p0' && x.kind === 'player')!;
    void e;
    const probeCtx = (rt as unknown as { world: { playerEntity(id: string): { x: number; y: number } } }).world;
    for (let i = 0; i < 30 * SPS && evs(rt, 'sneak.woke').length === 0; i++) {
      const av = probeCtx.playerEntity('p0');
      av.x = 760; av.y = 360 + (i % 120 < 60 ? -40 : 40);
      rt.input('p0', { t: i, axes: { x: 0, y: i % 120 < 60 ? 1 : -1 } });
      rt.step();
    }
    const pen = evs(rt, 'score').find((e) => (e.data!.delta as number) < 0);
    expect(pen?.data).toMatchObject({ delta: -2, reason: 'Woke the guard!' });
  });

  test('timeline: golden kind drops a golden item next to the bear; frenzy fills the field', () => {
    const probe = makeProbe();
    const rt = runtime(
      makeSpec(heistBlocks({}, { maxItems: 4 }), {
        timeline: [
          { atSec: 1, kind: 'golden-ladoo', params: {}, hostLine: 'gold!' },
          { atSec: 2, kind: 'ladoo-frenzy', params: {}, hostLine: 'frenzy!' },
        ],
      }),
      players(1), 1, [probe.def],
    );
    const ctx = probe.ctx();
    for (let i = 0; i < 1.1 * SPS; i++) rt.step();
    const gold = ctx.world.byKind('item').filter((i) => i.props.golden);
    expect(gold).toHaveLength(1);
    expect(Math.hypot(gold[0]!.x - 640, gold[0]!.y - 360)).toBeLessThan(120);
    expect(evs(rt, 'heist.golden')[0]!.data).toMatchObject({ phase: 'spawn' });
    for (let i = 0; i < SPS; i++) rt.step();
    expect(ctx.world.byKind('item').length).toBeGreaterThanOrEqual(10);
  });
});

// ---------- penguins: knockback, shove knockouts, crumbling floor ----------

describe('penguin mechanics', () => {
  const penguin = (dodge: Record<string, unknown> = {}): BlockUse[] => [
    { block: 'arena-move', params: { friction: 1, accel: 700, dashShove: 2.5 } },
    { block: 'dodge', params: { pattern: 'sweep', startRate: 0.1, maxRate: 0.5, onHit: 'losePoints', hitPenalty: 2, hitKnockback: 500, knockoutPoints: 3, crumbleLastSec: 10, callout: 'penguin', ...dodge } },
    { block: 'probe', params: {} },
  ];

  test('floor tiles crumble from the edge in the final seconds; a hole is a hit that knocks you inward', () => {
    const probe = makeProbe();
    const rt = runtime(makeSpec(penguin({ startRate: 0.1, rampPerSec: 0 })), players(1), 1, [probe.def]);
    const ctx = probe.ctx();
    const tiles = () => ctx.world.byKind('tile');
    const n0 = tiles().length;
    expect(n0).toBe(60);
    while (rt.remaining > 10.01) rt.step();
    expect(tiles().some((t) => t.props.crumbling)).toBe(false);
    rt.step();
    rt.step();
    expect(tiles().filter((t) => t.props.crumbling).length).toBeGreaterThan(0);
    expect(evs(rt, 'penguin.crumble')[0]!.data).toMatchObject({ ring: 0, phase: 'warn' });
    for (let i = 0; i < 3 * SPS; i++) rt.step();
    expect(tiles().length).toBeLessThan(n0);
    expect(evs(rt, 'penguin.crumble').some((e) => e.data!.phase === 'fall')).toBe(true);
    // stand in the hole at the edge
    const e = ctx.entityOf('p0')!;
    (rt as unknown as { players: Player[] }).players[0]!.score = 10;
    e.x = 40; e.y = 40; e.vx = e.vy = 0; e.props.invulnUntil = 0;
    rt.step();
    expect(scoreOf(rt, 'p0')).toBe(8);
    expect(e.vx).toBeGreaterThan(0);
    expect(e.vy).toBeGreaterThan(0);
    expect(evs(rt, 'score').at(-1)!.data!.reason).toBe('Hazard!');
  });

  test('a dash shove that sends a rival into the lava scores a knockout for the shover', () => {
    const probe = makeProbe();
    const rt = runtime(makeSpec(penguin({ startRate: 0.1, rampPerSec: 0 })), players(2), 1, [probe.def]);
    const ctx = probe.ctx();
    // wait until the outer ring has dropped
    while (!evs(rt, 'penguin.crumble').some((e) => e.data!.phase === 'fall')) rt.step();
    const a = ctx.entityOf('p0')!, b = ctx.entityOf('p1')!;
    (rt as unknown as { players: Player[] }).players[1]!.score = 5;
    // victim just inside solid ground (outer column is gone: x < 128), shover to its right
    b.x = 170; b.y = 360; b.vx = b.vy = 0; b.props.invulnUntil = 0;
    a.x = b.x + a.r + b.r + 2; a.y = 360; a.vx = a.vy = 0; a.props.invulnUntil = 0;
    rt.input('p0', { t: 0, axes: { x: -1, y: 0 }, buttons: { dash: true } });
    rt.step();
    for (let i = 0; i < SPS && evs(rt, 'penguin.knockout').length === 0; i++) {
      rt.input('p0', { t: i, axes: { x: 0, y: 0 } });
      rt.step();
    }
    expect(evs(rt, 'arena.shove').length).toBeGreaterThanOrEqual(1);
    expect(evs(rt, 'penguin.knockout')).toHaveLength(1);
    expect(evs(rt, 'penguin.knockout')[0]).toMatchObject({ player: 'p0', data: { victim: 'p1', moment: 'knockout' } });
    const ko = evs(rt, 'score').find((e) => e.data!.reason === 'Knockout!');
    expect(ko?.player).toBe('p0');
    expect(ko?.data!.delta).toBe(6); // 3, doubled in the final 10 s
  });
});

// ---------- tug: rhythm-mash, surge, splash ----------

describe('bear tug mechanics', () => {
  const tugSpec = (params: Record<string, unknown> = {}) =>
    makeSpec([{ block: 'tug', params: { mode: 'beat', rhythmBpm: 120, fatigue: 0, ...params } }], {
      arena: { kind: 'tug', width: 1280, height: 720 }, teams: 2, win: { type: 'teamScore' }, durationSec: 60,
      controller: [{ kind: 'button', id: 'pull', label: 'PULL' }],
    });
  const rope = (rt: GameRuntime) => rt.snapshot().entities.find((e) => e.kind === 'rope')!;
  // 120 bpm = a beat every 30 steps; frame f taps on step k when f(k)
  const drive = (rt: GameRuntime, n: number, f: Record<string, (k: number) => boolean>) => {
    for (let k = 0; k < n; k++) {
      for (const [id, on] of Object.entries(f)) rt.input(id, { t: k, buttons: { pull: on(k) } } as InputFrame);
      rt.step();
    }
  };

  test('beat mode: same tap rate, but on-beat taps pull harder', () => {
    const rt = runtime(tugSpec(), players(2));
    // both tap once per beat: p0 dead on the beat, p1 a third of a beat late
    drive(rt, 3 * SPS, { p0: (k) => (k + 1) % 30 === 0, p1: (k) => (k + 11) % 30 === 0 });
    expect(rope(rt).props.pos as number).toBeLessThan(-0.15);
    expect(rope(rt).props.bpm).toBe(120);
  });

  test('a team that stays on the beat surgeCombo times in a row SURGES', () => {
    const rt = runtime(tugSpec({ surgeCombo: 4 }), players(4));
    // team 0 (p0, p2) on the beat; team 1 (p1, p3) off the beat
    const on = (k: number) => (k + 1) % 30 === 0, off = (k: number) => (k + 15) % 30 === 0;
    drive(rt, 4 * SPS, { p0: on, p2: on, p1: off, p3: off });
    const surges = evs(rt, 'tug.surge');
    expect(surges.length).toBeGreaterThanOrEqual(1);
    expect(surges.every((e) => e.data!.team === 0)).toBe(true);
  });

  test('a bout win splashes the losers into the mud and pays the winners', () => {
    const rt = runtime(tugSpec({ forcePerTap: 120 }), players(2));
    drive(rt, 20 * SPS, { p0: (k) => k % 6 === 0, p1: () => false });
    const splash = evs(rt, 'tug.splash');
    expect(splash.length).toBeGreaterThanOrEqual(1);
    expect(splash[0]!.data).toMatchObject({ team: 1, winners: 0, moment: 'splash' });
    expect(rope(rt).props.splashTeam).toBe(1);
    expect(evs(rt, 'score').find((e) => e.player === 'p0')!.data!.reason).toBe('Splashed them!');
  });

  test('sudden death speeds the beat up', () => {
    const rt = runtime(tugSpec({ suddenDeathAtSec: 5, suddenDeathBpmMul: 1.5 }), players(2));
    drive(rt, 6 * SPS, {});
    expect(rope(rt).props.bpm).toBe(180);
  });

  test('timeline swing (bear-sneeze) lurches the knot toward the team behind', () => {
    const spec = tugSpec();
    spec.timeline = [{ atSec: 1, kind: 'bear-sneeze', params: {}, hostLine: 'achoo' }];
    const rt = runtime(spec, players(2));
    (rt as unknown as { players: Player[] }).players[0]!.score = 6; // team 0 ahead: team 1 gets the lurch
    drive(rt, 1.2 * SPS, {});
    expect(evs(rt, 'tug.swing')[0]!.data).toMatchObject({ team: 1 });
    expect(rope(rt).props.pos as number).toBeGreaterThan(0);
  });
});

// ---------- the fallback library ----------

describe('fallback games', () => {
  const reg = () => { const r = new BlockRegistry(); registerBuiltins(r); return r; };

  test.each(FALLBACK_SPECS.map((s) => [s.id, s] as const))('%s parses and passes the strict playtest at every seat count', (_id, spec) => {
    expect(parseSpec(spec).ok).toBe(true);
    for (const n of spec.teams === 2 ? [4] : [2, 3, 4]) {
      expect(playtest(spec, reg(), { players: n }).reasons).toEqual([]);
    }
  });

  test.each(FALLBACK_SPECS.map((s) => [s.id, s] as const))('%s: bots make close, eventful rounds (balance smoke)', (_id, spec) => {
    const rs = [1, 2, 3, 4, 5, 6].map((seed) => playRound(spec, seed));
    const meanLead = rs.reduce((a, r) => a + r.leadChanges, 0) / rs.length;
    expect(meanLead).toBeGreaterThanOrEqual(2);
    for (const r of rs) expect(r.events['final.start']).toBe(1);
    const moments = rs.flatMap((r) => Object.keys(r.events)).filter((k) => !k.startsWith('lead') && !k.startsWith('final'));
    expect(new Set(moments).size).toBeGreaterThanOrEqual(2);
  });

  test('every block param the fallbacks use is in the AI kit with a description', () => {
    const kit = new Map(kitCatalog(reg()).map((k) => [k.id, k.params as { properties: Record<string, { description?: string }> }]));
    for (const spec of FALLBACK_SPECS) {
      for (const use of spec.blocks) {
        for (const key of Object.keys(use.params)) expect(kit.get(use.block)!.properties[key]?.description, `${use.block}.${key}`).toBeTruthy();
      }
    }
  });
});
