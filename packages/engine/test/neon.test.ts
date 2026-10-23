import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { FALLBACK_SPECS, LEGACY_FALLBACK_IDS, NEON_ART_KEYS, PROP_KINDS, THEME_PALETTES, fallbackById, type BlockUse, type GameSpec, type InputFrame } from '@cadabra/spec';
import { BlockRegistry, GameRuntime, playtest, registerBuiltins, type BlockCtx, type BlockDef, type Player } from '../src/index';
import type { Entity } from '../src/world';

const SPS = 60;

function makeSpec(blocks: BlockUse[], over: Partial<GameSpec> = {}): GameSpec {
  return {
    version: 1, id: 'neon', title: 'Neon', hook: 'neon test',
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
}

const players = (n: number): Player[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, avatar: 'a', isBot: false, connected: true, score: 0 }));

function makeProbe() {
  let captured: BlockCtx<unknown> | undefined;
  const def: BlockDef<Record<string, never>> = {
    id: 'probe', name: 'Probe', summary: 'test only',
    paramsSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
    defaults: {}, controls: [], arenaKinds: ['topdown', 'lanes'],
    setup(ctx) { captured = ctx as BlockCtx<unknown>; },
    update() {}, onInput() {}, bot() { return { t: 0 }; },
  };
  return { def, ctx: () => captured! };
}

function world(spec: GameSpec, n: number) {
  const probe = makeProbe();
  const reg = new BlockRegistry();
  registerBuiltins(reg);
  reg.register(probe.def);
  const full = { ...spec, blocks: [...spec.blocks, { block: 'probe', params: {} }] };
  const rt = new GameRuntime(full, players(n), reg, 1, { finalMultiplier: 1 });
  const ctx = probe.ctx();
  const ent = (id: string) => ctx.entityOf(id)!;
  const setScore = (id: string, v: number) => { (rt as unknown as { players: Player[] }).players.find((p) => p.id === id)!.score = v; };
  return { rt, ctx, ent, setScore };
}

const evs = (rt: GameRuntime, type: string) => rt.events.filter((e) => e.type === type);
const scoreOf = (rt: GameRuntime, id: string) => rt.snapshot().players.find((p) => p.id === id)!.score;
const steps = (rt: GameRuntime, n: number, inputs: Record<string, InputFrame> = {}) => {
  for (let i = 0; i < n; i++) {
    for (const [id, f] of Object.entries(inputs)) rt.input(id, { ...f, t: Math.round(rt.time * 1000) });
    rt.step();
  }
};
const park = (e: Entity, x: number, y: number) => { e.x = x; e.y = y; e.vx = 0; e.vy = 0; };

// ---------- RING OUT ----------

describe('ring out (arena-move ringOut)', () => {
  const ring = (extra: Record<string, unknown> = {}) =>
    makeSpec([{ block: 'arena-move', params: { ringOut: true, ringRadius: 330, ringTile: 48, ringShrinkTo: 150, dashShove: 2, ...extra } }]);

  test('the platform is a disc of floor tiles with rings numbered from the edge', () => {
    const { ctx } = world(ring(), 2);
    const tiles = ctx.world.byKind('tile');
    expect(tiles.length).toBeGreaterThan(100);
    expect(tiles.length).toBeLessThan(250);
    const outer = tiles.filter((t) => t.props.ring === 0);
    for (const t of outer) expect(Math.hypot(t.x - 640, t.y - 360)).toBeGreaterThan(330 - 48 * 1.4);
  });

  test('falling off credits the last pusher within 2 s (+3 RING OUT!), the faller loses 1 but never below 0', () => {
    const { rt, ent, setScore } = world(ring(), 3);
    setScore('p1', 4);
    steps(rt, 1);
    const v = ent('p1');
    park(v, 640 + 400, 360);
    v.props.touchedBy = 'p0';
    v.props.touchedAt = rt.time - 1;
    steps(rt, 1);
    expect(v.props.out).toBe(true);
    expect(scoreOf(rt, 'p0')).toBe(3);
    expect(scoreOf(rt, 'p1')).toBe(3);
    expect(evs(rt, 'play.ringout')[0]).toMatchObject({ player: 'p0', data: { victim: 'p1', moment: 'ringout' } });
    expect(evs(rt, 'score').find((e) => e.player === 'p0')!.data!.reason).toBe('RING OUT!');
    // a zero score is not pushed negative
    const w = ent('p2');
    park(w, 20, 20);
    steps(rt, 1);
    expect(w.props.out).toBe(true);
    expect(scoreOf(rt, 'p2')).toBe(0);
  });

  test('a stale touch (> ringCreditSec) earns no credit', () => {
    const { rt, ent } = world(ring(), 2);
    steps(rt, 3 * SPS);
    const v = ent('p1');
    v.props.touchedBy = 'p0';
    v.props.touchedAt = rt.time - 2.5;
    park(v, 1200, 360);
    steps(rt, 1);
    expect(v.props.out).toBe(true);
    expect(scoreOf(rt, 'p0')).toBe(0);
    expect(evs(rt, 'arena.fall').at(-1)!.data).toMatchObject({ by: null });
  });

  test('respawn in the centre after 1.5 s with 1 s of invulnerability (no fall, no bumps)', () => {
    const { rt, ent } = world(ring(), 2);
    steps(rt, 1);
    const v = ent('p1');
    park(v, 1200, 360);
    steps(rt, 1);
    const fellAt = rt.time;
    expect(v.props.out).toBe(true);
    steps(rt, Math.round(1.4 * SPS));
    expect(v.props.out).toBe(true);
    steps(rt, Math.round(0.2 * SPS));
    expect(v.props.out).toBe(false);
    expect(Math.hypot(v.x - 640, v.y - 360)).toBeLessThan(60);
    expect(v.props.invulnUntil as number).toBeCloseTo(fellAt + 1.5 + 1, 1);
    expect(evs(rt, 'arena.respawn')).toHaveLength(1);
    // invulnerable: standing over the void does not drop you
    park(v, 1200, 360);
    steps(rt, Math.round(0.5 * SPS));
    expect(v.props.out).toBe(false);
    steps(rt, Math.round(0.6 * SPS));
    expect(v.props.out).toBe(true);
  });

  test('rings crumble inward over the round (warn, then fall) and survivors score', () => {
    const { rt, ctx } = world(ring({ ringSurvivePoints: 1 }), 2);
    const before = ctx.world.byKind('tile').length;
    steps(rt, 59 * SPS);
    const crumbles = evs(rt, 'play.crumble');
    expect(crumbles.filter((e) => (e.data as { phase: string }).phase === 'warn').length).toBeGreaterThanOrEqual(3);
    expect(crumbles.filter((e) => (e.data as { phase: string }).phase === 'fall').length).toBeGreaterThanOrEqual(3);
    expect(ctx.world.byKind('tile').length).toBeLessThan(before / 2);
    expect(evs(rt, 'score').some((e) => e.data!.reason === 'SURVIVED')).toBe(true);
    // the centre always survives
    expect(ctx.world.byKind('tile').some((t) => Math.hypot(t.x - 640, t.y - 360) < 30)).toBe(true);
  });

  test('the crumble timeline hook drops the next ring right away', () => {
    const spec = ring({ ringCrumbleEventKind: 'quake' });
    spec.timeline = [{ atSec: 2, kind: 'quake', params: {}, hostLine: 'quake' }];
    const { rt } = world(spec, 2);
    steps(rt, 4 * SPS);
    expect(evs(rt, 'play.crumble').map((e) => (e.data as { phase: string }).phase)).toEqual(['warn', 'fall']);
  });
});

// ---------- OVERLOAD ----------

describe('overload (arena-move overload)', () => {
  const ov = (extra: Record<string, unknown> = {}) => makeSpec([{ block: 'arena-move', params: {
    overload: true, overloadCores: 1, overloadFuseMin: 7, overloadFuseMax: 7, overloadPenalty: 3, overloadReward: 1,
    overloadAssistPoints: 1, overloadClutchPoints: 0, overloadSafePoints: 0, overloadPassImmunitySec: 0.8, ...extra,
  } }]);
  const spread = (ent: (id: string) => Entity, n: number) => {
    const spots = [[100, 100], [1180, 100], [100, 620], [1180, 620]];
    for (let i = 0; i < n; i++) park(ent(`p${i}`), spots[i]![0]!, spots[i]![1]!);
  };
  const core = (ctx: BlockCtx<unknown>) => ctx.world.byKind('core')[0];

  test('a core spawns on a random player; touching passes it; the passer is immune for 0.8 s', () => {
    const { rt, ctx, ent } = world(ov(), 3);
    spread(ent, 3);
    steps(rt, Math.round(1.6 * SPS));
    const c = core(ctx)!;
    expect(c.sprite).toBe('core-unstable');
    const a = c.props.holder as string;
    const b = ['p0', 'p1', 'p2'].find((id) => id !== a)!;
    park(ent(b), ent(a).x + ent(a).r * 2 + 2, ent(a).y);
    steps(rt, 1);
    expect(c.props.holder).toBe(b);
    expect(evs(rt, 'arena.pass')[0]).toMatchObject({ player: a, data: { to: b } });
    expect(evs(rt, 'play.core.pass')).toHaveLength(1);
    // still touching: it can't come straight back
    steps(rt, Math.round(0.5 * SPS));
    expect(c.props.holder).toBe(b);
    steps(rt, Math.round(0.4 * SPS));
    expect(c.props.holder).toBe(a);
  });

  test('the holder is faster', () => {
    const { rt, ctx, ent } = world(ov({ overloadHolderSpeed: 1.3 }), 2);
    spread(ent, 2);
    steps(rt, Math.round(1.6 * SPS));
    const h = core(ctx)!.props.holder as string;
    const o = h === 'p0' ? 'p1' : 'p0';
    steps(rt, SPS, { [h]: { t: 0, axes: { x: 0, y: 1 } }, [o]: { t: 0, axes: { x: 0, y: 1 } } });
    expect(Math.hypot(ent(h).vx, ent(h).vy)).toBeGreaterThan(Math.hypot(ent(o).vx, ent(o).vy) * 1.2);
  });

  test('the fuse telegraphs (pulse, critical) and detonates: holder -3 and stunned, others +1, the passer +1 more; then a new core', () => {
    const { rt, ctx, ent, setScore } = world(ov(), 3);
    spread(ent, 3);
    steps(rt, Math.round(1.6 * SPS));
    const c = core(ctx)!;
    const a = c.props.holder as string;
    const b = ['p0', 'p1', 'p2'].find((id) => id !== a)!;
    const third = ['p0', 'p1', 'p2'].find((id) => id !== a && id !== b)!;
    park(ent(b), ent(a).x + ent(a).r * 2 + 2, ent(a).y);
    steps(rt, 1);
    park(ent(a), 640, 360); // walk away from the new holder
    setScore(b, 5);
    const pulse0 = c.props.pulseHz as number;
    steps(rt, Math.round(4.5 * SPS));
    expect(c.props.pulseHz as number).toBeGreaterThan(pulse0);
    expect(evs(rt, 'play.core.critical')).toHaveLength(1);
    steps(rt, Math.round(2.6 * SPS));
    expect(evs(rt, 'play.overload')).toHaveLength(1);
    expect(evs(rt, 'play.overload')[0]).toMatchObject({ player: b, data: { moment: 'overload', passer: a } });
    expect(scoreOf(rt, b)).toBe(2);
    expect(scoreOf(rt, a)).toBe(2); // +1 survived +1 handoff
    expect(scoreOf(rt, third)).toBe(1);
    expect(evs(rt, 'score').find((e) => e.player === b)!.data!.reason).toBe('OVERLOAD!');
    expect(ent(b).props.stunUntil as number).toBeGreaterThan(rt.time);
    expect(core(ctx)).toBeUndefined();
    steps(rt, Math.round(1.6 * SPS));
    expect(core(ctx)).toBeDefined();
    expect(evs(rt, 'arena.core')).toHaveLength(2);
  });

  test('two cores with four players; every 5 s players without a core earn safe points', () => {
    const { rt, ctx, ent } = world(ov({ overloadCores: 2, overloadSafePoints: 1 }), 4);
    spread(ent, 4);
    steps(rt, Math.round(5.1 * SPS));
    const cores = ctx.world.byKind('core');
    expect(cores).toHaveLength(2);
    const holders = new Set(cores.map((c) => c.props.holder));
    expect(holders.size).toBe(2);
    const clean = evs(rt, 'score').filter((e) => e.data!.reason === 'CLEAN');
    expect(clean).toHaveLength(2);
    for (const e of clean) expect(holders.has(e.player!)).toBe(false);
  });
});

// ---------- PAINT ----------

describe('paint (arena-move paint)', () => {
  const paint = (extra: Record<string, unknown> = {}, over: Partial<GameSpec> = {}) => makeSpec([{ block: 'arena-move', params: {
    paint: true, paintCols: 16, paintRows: 9, paintEverySec: 5, paintPoints: 10, paintFinalMul: 2, paintBurst: 1, dashShove: 2, shoveStunSec: 0.6, ...extra,
  } }], over);
  const tileAt = (ctx: BlockCtx<unknown>, x: number, y: number) =>
    ctx.world.byKind('tile').find((t) => Math.abs(t.x - x) <= (t.props.hw as number) && Math.abs(t.y - y) <= (t.props.hh as number))!;

  test('moving paints the tile under you; a dash paints a 3x3 burst', () => {
    const { rt, ctx, ent } = world(paint(), 2);
    expect(ctx.world.byKind('tile')).toHaveLength(144);
    park(ent('p0'), 200, 200);
    park(ent('p1'), 1100, 600);
    steps(rt, 1);
    expect(tileAt(ctx, 200, 200).props.paintedBy).toBe('p0');
    expect(tileAt(ctx, 200, 200).props.paint).toBe(0);
    steps(rt, 1, { p1: { t: 0, axes: { x: -1, y: 0 }, buttons: { dash: true } } });
    const painted = ctx.world.byKind('tile').filter((t) => t.props.paintedBy === 'p1');
    expect(painted.length).toBeGreaterThanOrEqual(9);
  });

  test('tallies every 5 s pay by share; the final tally pays double', () => {
    const { rt, ctx, ent } = world(paint(), 2);
    park(ent('p0'), 200, 200);
    park(ent('p1'), 1100, 600);
    steps(rt, 1, { p1: { t: 0, axes: { x: -1, y: 0 }, buttons: { dash: true } } });
    steps(rt, 5 * SPS);
    const tallies = evs(rt, 'play.tally');
    expect(tallies).toHaveLength(1);
    const n1 = ctx.world.byKind('tile').filter((t) => t.props.paintedBy === 'p1').length;
    expect(scoreOf(rt, 'p1')).toBe(Math.round((10 * n1) / 144));
    expect(evs(rt, 'score').find((e) => e.player === 'p1')!.data!.reason).toBe('TERRITORY');
    steps(rt, 60 * SPS);
    const fin = evs(rt, 'play.tally.final');
    expect(fin).toHaveLength(1);
    const last = evs(rt, 'score').filter((e) => e.player === 'p1').at(-1)!;
    expect(last.data!.reason).toBe('FINAL TALLY');
    expect(last.data!.delta).toBe(Math.round((20 * n1) / 144));
  });

  test('team games paint team colours and score team share; a dash shove stuns an enemy 0.6 s but never a teammate', () => {
    const spec = paint({}, { teams: 2, win: { type: 'teamScore' } });
    const t = world(spec, 4);
    park(t.ent('p0'), 300, 300); // team 0
    park(t.ent('p2'), 900, 300); // team 0
    park(t.ent('p1'), 300 + 40, 500); // team 1
    park(t.ent('p3'), 1100, 650); // team 1
    steps(t.rt, 1);
    expect(t.ctx.world.byKind('tile').find((x) => x.props.paintedBy === 'p2')!.props.paintTeam).toBe(0);
    expect(t.ctx.world.byKind('tile').find((x) => x.props.paintedBy === 'p3')!.team).toBe(1);
    // p1 dashes down... put p0 right below p1 and dash into it
    park(t.ent('p0'), 340, 560);
    steps(t.rt, 6, { p1: { t: 0, axes: { x: 0, y: 1 }, buttons: { dash: true } } });
    expect(t.ent('p0').props.stunUntil as number).toBeGreaterThan(t.rt.time + 0.3);
    // teammates: no stun
    park(t.ent('p3'), 1000, 560);
    park(t.ent('p1'), 1000, 500);
    t.ent('p3').props.stunUntil = 0;
    steps(t.rt, Math.round(1.7 * SPS));
    steps(t.rt, 6, { p1: { t: 0, axes: { x: 0, y: 1 }, buttons: { dash: true } } });
    expect((t.ent('p3').props.stunUntil as number) ?? 0).toBeLessThanOrEqual(t.rt.time);
  });

  test('odd teams auto-balance: the solo player scores double per tile', () => {
    const w = world(paint({ paintPoints: 50 }, { teams: 2, win: { type: 'teamScore' } }), 3); // p0, p2 team 0; p1 alone
    park(w.ent('p0'), 200, 200);
    park(w.ent('p2'), 1100, 600);
    park(w.ent('p1'), 200, 560);
    steps(w.rt, 1, { p0: { t: 0, axes: { x: 1, y: 0 }, buttons: { dash: true } }, p1: { t: 0, axes: { x: 1, y: 0 }, buttons: { dash: true } } });
    steps(w.rt, 5 * SPS);
    const n = (id: string) => w.ctx.world.byKind('tile').filter((t) => t.props.paintedBy === id).length;
    expect(scoreOf(w.rt, 'p1')).toBe(Math.round((50 * n('p1') * 2) / 144));
    expect(scoreOf(w.rt, 'p0')).toBe(Math.round((50 * n('p0')) / 144));
  });
});

// ---------- CORE RUSH ----------

describe('core rush (collect teamBases + stealNeedsDash + knockLoose)', () => {
  const rush = () => makeSpec([
    { block: 'arena-move', params: { dashShove: 1.8, shoveStunSec: 0.35, dashPower: 2.6 } },
    { block: 'collect', params: {
      itemSprite: 'core', carryToGoal: true, teamBases: true, goalRadius: 80, carryMax: 2, bankBonus: 0, carrySlowdown: 0.15,
      spawnArea: 'centre', spawnRadius: 200, maxItems: 1, spawnEverySec: 999, stealOnBump: true, stealNeedsDash: true, knockLoose: true,
      goldenChance: 0, bankLabel: 'BANKED', callout: 'rush',
    } },
  ], { teams: 2, win: { type: 'teamScore' } });

  test('one base per team at the left and right edges', () => {
    const { ctx } = world(rush(), 4);
    const bases = ctx.world.byKind('base');
    expect(bases).toHaveLength(2);
    expect(bases.map((b) => [b.team, b.props.teamBase])).toEqual([[0, true], [1, true]]);
    expect(bases[0]!.x).toBeLessThan(200);
    expect(bases[1]!.x).toBeGreaterThan(1080);
  });

  test('bank, steal-by-dash knock-loose, teammates never robbed (full flow with real spawns)', () => {
    const { rt, ctx, ent } = world(rush(), 4);
    for (const [id, x, y] of [['p0', 640, 360], ['p1', 1100, 650], ['p2', 300, 650], ['p3', 1100, 100]] as const) park(ent(id), x, y);
    // walk p0 onto each spawned core until it carries 2
    for (let k = 0; k < 600 && ((ent('p0').props.carry as number) ?? 0) < 1; k++) {
      const it = ctx.world.byKind('item').find((i) => i.props.carriedBy === '');
      if (it) park(ent('p0'), it.x, it.y);
      steps(rt, 1);
    }
    expect(ent('p0').props.carry).toBe(1);
    expect(ent('p0').props.loadMul).toBeCloseTo(0.85);
    // a plain bump from an enemy does nothing
    park(ent('p1'), ent('p0').x + 70, ent('p0').y);
    steps(rt, 20, { p1: { t: 0, axes: { x: -1, y: 0 } } });
    expect(ent('p0').props.carry).toBe(1);
    // a dash knocks it loose (not into the thief's hands)
    park(ent('p0'), 640, 360);
    park(ent('p1'), 640 + 90, 360);
    steps(rt, 15, { p1: { t: 0, axes: { x: -1, y: 0 }, buttons: { dash: true } } });
    expect(ent('p0').props.carry).toBe(0);
    const steal = evs(rt, 'rush.steal');
    expect(steal).toHaveLength(1);
    expect(steal[0]).toMatchObject({ player: 'p1', data: { from: 'p0', loose: true } });
    expect(ctx.world.byKind('item').some((i) => i.props.carriedBy === '')).toBe(true);
    // pick a core up again and bank it at team 0's base
    for (let k = 0; k < 600 && ((ent('p0').props.carry as number) ?? 0) < 1; k++) {
      const it = ctx.world.byKind('item').find((i) => i.props.carriedBy === '');
      if (it) park(ent('p0'), it.x, it.y);
      steps(rt, 1);
    }
    // teammate p2 dashes into p0: nothing
    park(ent('p0'), 640, 360);
    park(ent('p2'), 640 - 90, 360);
    steps(rt, Math.round(1.5 * SPS));
    steps(rt, 15, { p2: { t: 0, axes: { x: 1, y: 0 }, buttons: { dash: true } } });
    expect(ent('p0').props.carry).toBe(1);
    const base0 = ctx.world.byKind('base').find((b) => b.team === 0)!;
    park(ent('p0'), base0.x, base0.y);
    steps(rt, 1);
    expect(ent('p0').props.carry).toBe(0);
    const bank = evs(rt, 'score').filter((e) => e.data!.reason === 'BANKED');
    expect(bank).toHaveLength(1);
    expect(bank[0]).toMatchObject({ player: 'p0', data: { delta: 1 } });
    expect(evs(rt, 'rush.bank')).toHaveLength(1);
  });
});

// ---------- NEON DASH ----------

describe('neon dash (race laser gates)', () => {
  test('gates switch on and off; only a live gate trips a runner', () => {
    const spec = makeSpec([{ block: 'race', params: {
      laneCount: 2, trackLength: 2000, laps: 3, checkpointCount: 0, obstacleDensity: 0.3, boostPads: 0, mashToRun: false,
      runSpeed: 300, gateCycleSec: 2, gateOnFrac: 0.5, obstacleSprite: 'laser', padSprite: 'boost', finishLine: true,
    } }], { arena: { kind: 'lanes', width: 1280, height: 720 }, controller: [{ kind: 'hold', id: 'run', label: 'Run' }, { kind: 'button', id: 'jump', label: 'Jump' }] });
    const { rt, ctx } = world(spec, 2);
    const lasers = ctx.world.byKind('obstacle');
    expect(lasers.length).toBe(6);
    expect(lasers.every((l) => l.sprite === 'laser' && l.props.gate === true)).toBe(true);
    expect(ctx.world.byKind('finish')).toHaveLength(1);
    const seen = new Set<boolean>();
    let stumblesOnLive = 0, stumbles = 0;
    for (let i = 0; i < 20 * SPS; i++) {
      rt.input('p0', { t: i, buttons: { run: true } });
      rt.step();
      seen.add(lasers[0]!.props.armed as boolean);
      const st = evs(rt, 'race.stumble');
      if (st.length > stumbles) {
        stumbles = st.length;
        if (lasers.some((l) => l.props.armed === true)) stumblesOnLive++;
      }
    }
    expect(seen).toEqual(new Set([true, false]));
    expect(stumbles).toBeGreaterThan(0);
    expect(stumblesOnLive).toBe(stumbles);
    // with 6 gate crossings per 20 s, some are passed while off
    expect(evs(rt, 'score').filter((e) => e.player === 'p0' && e.data!.reason === 'race.lap').length).toBeGreaterThan(0);
  });
});

// ---------- the lineup ----------

describe('neon lineup', () => {
  const reg = () => { const r = new BlockRegistry(); registerBuiltins(r); return r; };

  test('the lineup: seven games, each on its theme look, only known art keys', () => {
    expect(FALLBACK_SPECS.map((s) => s.id)).toEqual([
      'fallback-ring-out', 'fallback-overload', 'fallback-paint-wars', 'fallback-core-rush', 'fallback-neon-dash',
      'fallback-rocket-ball', 'fallback-crate-crash',
    ]);
    const looks: Record<string, string> = {
      'fallback-ring-out': 'toybox', 'fallback-overload': 'cosmos', 'fallback-paint-wars': 'retro', 'fallback-core-rush': 'cosmos',
      'fallback-neon-dash': 'neon', 'fallback-rocket-ball': 'neon', 'fallback-crate-crash': 'toybox',
    };
    const keys = new Set([...NEON_ART_KEYS, ...PROP_KINDS, 'net']);
    for (const s of FALLBACK_SPECS) {
      const look = s.theme.look!;
      expect(look, s.id).toBe(looks[s.id]);
      expect(s.theme.sfxSet).toBe(look);
      expect(s.theme.palette).toEqual(THEME_PALETTES[look]);
      for (const k of Object.keys(s.theme.sprites)) expect(keys.has(k as never), `${s.id}: ${k}`).toBe(true);
      expect(s.durationSec).toBeGreaterThanOrEqual(60);
      expect(s.durationSec).toBeLessThanOrEqual(75);
      expect(s.host.intro.length).toBeLessThanOrEqual(90);
    }
  });

  test('legacy ids map to their replacements', () => {
    for (const [old, now] of Object.entries(LEGACY_FALLBACK_IDS)) expect(fallbackById(old)!.id).toBe(now);
    expect(fallbackById('fallback-neon-dash')!.title).toBe('NEON DASH');
  });

  test.each(FALLBACK_SPECS.map((s) => [s.id, s] as const))('%s plays as a 30 s and 45 s quick-fire round', (_id, base) => {
    for (const d of [30, 45]) {
      const k = d / base.durationSec;
      const timeline = base.timeline.map((ev) => ({ ...ev, atSec: ev.atSec >= base.durationSec - 10 ? d - (base.durationSec - ev.atSec) : Math.round(ev.atSec * k) }));
      const spec = { ...base, durationSec: d, timeline };
      for (const n of spec.teams === 2 ? [4] : [2, 4]) expect(playtest(spec, reg(), { players: n }).reasons).toEqual([]);
    }
  });
});
