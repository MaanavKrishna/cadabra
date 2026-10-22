import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { BlockUse, GameSpec, InputFrame } from '@cadabra/spec';
import { BlockRegistry, GameRuntime, stubJudgement, type BlockCtx, type BlockDef, type Player } from '../src/index';
import { drawJudge, registerBuiltins, sneak, trivia, tug, FALLBACK_QUESTIONS } from '../src/blocks/index';
import heist from '../../spec/test/fixtures/heist.json';

const SPS = 60;

function makeSpec(blocks: BlockUse[], kind: GameSpec['arena']['kind'] = 'topdown', over: Partial<GameSpec> = {}): GameSpec {
  return {
    version: 1,
    id: 'blocks-b',
    title: 'Blocks B',
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
    origin: { ingredients: ['cats', 'pizza'], wild: false },
    ...over,
  };
}

function makePlayers(n: number, isBot = false): Player[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, name: `P${i}`, avatar: 'a', isBot, connected: true, score: 0,
  }));
}

function makeProbe() {
  let captured: BlockCtx<unknown> | undefined;
  const def: BlockDef<Record<string, never>> = {
    id: 'probe',
    name: 'Probe',
    summary: 'test only',
    paramsSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
    defaults: {},
    controls: [],
    arenaKinds: ['topdown'],
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

/** Bots play; judgements are stub-resolved (like playtest) when `resolve` is set. */
function playBots(rt: GameRuntime, ids: string[], skill: number, seconds: number, resolve = false) {
  for (let i = 0; i < seconds * SPS && rt.state !== 'over'; i++) {
    if (resolve) for (const j of rt.pendingJudgements()) rt.resolveJudgement(j.id, stubJudgement(j));
    for (const id of ids) rt.input(id, rt.botInput(id, skill));
    rt.step();
  }
}

function steps(rt: GameRuntime, n: number, input?: (i: number) => Record<string, InputFrame>) {
  for (let i = 0; i < n; i++) {
    if (input) for (const [id, f] of Object.entries(input(i))) rt.input(id, f);
    rt.step();
  }
}

const B = [sneak, tug, drawJudge, trivia] as BlockDef[];
const total = (rt: GameRuntime) => rt.result().ranking.reduce((a, p) => a + p.score, 0);
const evs = (rt: GameRuntime, type: string) => rt.events.filter((e) => e.type === type);

describe('builtins registry (b)', () => {
  test('registerBuiltins registers sneak, tug, draw-judge, trivia', () => {
    const reg = new BlockRegistry();
    registerBuiltins(reg);
    for (const id of ['sneak', 'tug', 'draw-judge', 'trivia']) expect(reg.get(id)?.id).toBe(id);
  });

  test.each(B.map((d) => [d.id, d] as const))('%s: all params from defaults validate', (_id, def) => {
    const r = def.paramsSchema.safeParse(def.defaults);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(def.defaults);
    expect(def.name.length).toBeGreaterThan(0);
    expect(def.summary.length).toBeGreaterThan(0);
    expect(def.arenaKinds.length).toBeGreaterThan(0);
  });

  test('brief params are present', () => {
    for (const k of ['guardSprite', 'guardKind', 'noiseLimit', 'noisePerMove', 'tiptoeButton', 'tiptoeSpeedFactor', 'wakeDurationSec', 'wakePenalty', 'visionConeDeg'])
      expect(sneak.defaults).toHaveProperty(k);
    for (const k of ['mode', 'ropeLength', 'forcePerTap', 'fatigue', 'rhythmBpm', 'suddenDeathAtSec']) expect(tug.defaults).toHaveProperty(k);
    for (const k of ['prompt', 'drawSec', 'rounds', 'judgeStyle']) expect(drawJudge.defaults).toHaveProperty(k);
    for (const k of ['questions', 'secondsPerQuestion', 'pointsFast', 'pointsSlow', 'aboutPlayers']) expect(trivia.defaults).toHaveProperty(k);
    expect(sneak.defaults.tiptoeButton).toBe('tiptoe');
  });

  test.each([
    ['sneak', [{ block: 'arena-move', params: {} }, { block: 'sneak', params: {} }, { block: 'collect', params: {} }], 'topdown', 0],
    ['tug', [{ block: 'tug', params: {} }], 'tug', 2],
    ['draw-judge', [{ block: 'draw-judge', params: {} }], 'canvas', 0],
    ['trivia', [{ block: 'trivia', params: {} }], 'quiz', 0],
  ] as const)('%s: bot rounds replay deterministically', (_id, blocks, kind, teams) => {
    const run = () => {
      const rt = runtime(makeSpec([...blocks] as BlockUse[], kind, { teams }), makePlayers(4, true), 9);
      playBots(rt, ['p0', 'p1', 'p2', 'p3'], 0.6, 40, true);
      return rt.events;
    };
    expect(run()).toEqual(run());
  });
});

// ---------- sneak ----------

describe('sneak', () => {
  const wiggle = (i: number) => ({ t: i, axes: { x: Math.floor(i / 20) % 2 ? 1 : -1, y: 0 } });

  test('moving without tiptoe past noiseLimit emits sneak.woke attributed to mover', () => {
    const rt = runtime(makeSpec([{ block: 'sneak', params: {} }]), makePlayers(2));
    steps(rt, 10 * SPS, (i) => ({ p0: wiggle(i), p1: { t: i } }));
    const woke = evs(rt, 'sneak.woke');
    expect(woke.length).toBeGreaterThan(0);
    expect(woke[0]!.player).toBe('p0');
    expect(woke.every((e) => e.player === 'p0')).toBe(true);
  });

  test('tiptoeing the same moves never wakes the guard', () => {
    const rt = runtime(makeSpec([{ block: 'sneak', params: {} }]), makePlayers(2));
    steps(rt, 10 * SPS, (i) => ({ p0: { ...wiggle(i), buttons: { tiptoe: true } }, p1: { t: i } }));
    expect(evs(rt, 'sneak.woke')).toHaveLength(0);
  });

  test('tiptoe slows the avatar by tiptoeSpeedFactor (also under arena-move)', () => {
    const dist = (tiptoe: boolean) => {
      const rt = runtime(makeSpec([{ block: 'arena-move', params: {} }, { block: 'sneak', params: { tiptoeSpeedFactor: 0.4 } }]), makePlayers(1));
      const x0 = rt.snapshot().entities.find((e) => e.owner === 'p0')!.x;
      steps(rt, 30, (i) => ({ p0: { t: i, axes: { x: 1, y: 0 }, buttons: { tiptoe } } }));
      return rt.snapshot().entities.find((e) => e.owner === 'p0')!.x - x0;
    };
    const fast = dist(false), slow = dist(true);
    expect(slow).toBeGreaterThan(0);
    expect(slow / fast).toBeLessThan(0.5);
  });

  test('guard telegraphs (stirring) before it wakes, and exposes renderer props', () => {
    const rt = runtime(makeSpec([{ block: 'sneak', params: {} }]), makePlayers(1));
    let stirredAt = -1, wokeAt = -1;
    for (let i = 0; i < 10 * SPS && wokeAt < 0; i++) {
      rt.input('p0', wiggle(i));
      rt.step();
      const g = rt.snapshot().entities.find((e) => e.kind === 'guard')!;
      expect(typeof g.props.noise).toBe('number');
      expect(typeof g.props.facing).toBe('number');
      expect(g.props.visionConeDeg).toBe(sneak.defaults.visionConeDeg);
      if (g.props.stirring && stirredAt < 0) stirredAt = rt.time;
      if (g.props.awake && wokeAt < 0) wokeAt = rt.time;
    }
    expect(stirredAt).toBeGreaterThan(0);
    expect(wokeAt).toBeGreaterThan(stirredAt + 0.3);
  });

  test('after a wake, frozen players are never caught; movers in the cone are', () => {
    const probe = makeProbe();
    const rt = runtime(makeSpec([{ block: 'sneak', params: { visionConeDeg: 90 } }, { block: 'probe', params: {} }]), makePlayers(3), 1, [probe.def]);
    const ctx = probe.ctx();
    let woke = false;
    for (let i = 0; i < 12 * SPS; i++) {
      // freeze on the wind-up telegraph (sneak.waking): the warning is the time to stop
      if (!woke && evs(rt, 'sneak.waking').length > 0) {
        woke = true;
        // p1 stands right next to the culprit, so it is in the guard's cone too
        const a = ctx.entityOf('p0')!, b = ctx.entityOf('p1')!;
        b.x = a.x;
        b.y = a.y + 50;
      }
      rt.input('p0', woke ? { t: i } : wiggle(i));
      rt.input('p1', woke ? { t: i, axes: { x: Math.floor(i / 10) % 2 ? 0.6 : -0.6, y: 0 } } : { t: i });
      rt.input('p2', { t: i });
      rt.step();
      if (woke && evs(rt, 'sneak.caught').length > 0) break;
    }
    const caught = evs(rt, 'sneak.caught');
    expect(caught.map((e) => e.player)).toContain('p1');
    expect(caught.map((e) => e.player)).not.toContain('p0');
    expect(caught.map((e) => e.player)).not.toContain('p2');
  });

  test.each(['patrol', 'watcher'] as const)('%s sight wake gives >= 0.75 s warning before any penalty', (guardKind) => {
    const probe = makeProbe();
    const rt = runtime(makeSpec([{ block: 'sneak', params: { guardKind } }, { block: 'probe', params: {} }]), makePlayers(1), 1, [probe.def]);
    const ctx = probe.ctx();
    ctx.score('p0', 10, 'seed');
    const guard = () => rt.snapshot().entities.find((e) => e.kind === 'guard')!;
    // stand right in front of the guard and keep moving (no tiptoe): sight wakes it
    let wakingAt = -1;
    for (let i = 0; i < 10 * SPS; i++) {
      const g = ctx.world.get(guard().id)!;
      const a = ctx.entityOf('p0')!;
      if (wakingAt < 0) {
        const f = g.props.facing as number;
        a.x = g.x + Math.cos(f) * 150;
        a.y = g.y + Math.sin(f) * 150;
      }
      rt.input('p0', wiggle(i));
      rt.step();
      if (wakingAt < 0 && guard().props.waking) wakingAt = rt.time;
      if (wakingAt >= 0 && rt.time > wakingAt + 2) break;
    }
    expect(wakingAt).toBeGreaterThan(0);
    const warnAt = evs(rt, 'sneak.waking')[0]!.t; // event clock (pre-step time)
    const penalties = rt.events.filter((e) => e.type === 'score' && (e.data!.delta as number) < 0);
    expect(penalties.length).toBeGreaterThan(0);
    for (const e of penalties) expect(e.t).toBeGreaterThanOrEqual(warnAt + 0.75 - 1e-9);
    const woke = evs(rt, 'sneak.woke');
    expect(woke).toHaveLength(1);
    expect(woke[0]!.t).toBeGreaterThanOrEqual(warnAt + 0.75 - 1e-9);
    expect(wakingAt - warnAt).toBeLessThanOrEqual(1 / SPS + 1e-9); // the guard shows it at once
  });

  test('live applyParams wakeDurationSec shortens a wake already in progress', () => {
    const rt = runtime(makeSpec([{ block: 'sneak', params: { wakeDurationSec: 8 } }]), makePlayers(1));
    let i = 0;
    while (evs(rt, 'sneak.woke').length === 0 && i < 15 * SPS) {
      rt.input('p0', wiggle(i++));
      rt.step();
    }
    steps(rt, 2 * SPS);
    const guard = () => rt.snapshot().entities.find((e) => e.kind === 'guard')!;
    expect(guard().props.awake).toBe(true);
    rt.applyParams(0, { wakeDurationSec: 1 });
    rt.step();
    expect(guard().props.awake).toBe(false);
  });

  test('live applyParams guardKind rebuilds guards', () => {
    const rt = runtime(makeSpec([{ block: 'sneak', params: {} }]), makePlayers(1));
    steps(rt, 10);
    rt.applyParams(0, { guardKind: 'patrol' });
    rt.step();
    const g = rt.snapshot().entities.filter((e) => e.kind === 'guard');
    expect(g).toHaveLength(1);
    expect(g[0]!.props.guardKind).toBe('patrol');
  });

  test.each(['sleeper', 'patrol', 'watcher'] as const)('bot at skill 0.7 scores > 0 in 60 s (%s)', (guardKind) => {
    const rt = runtime(makeSpec([{ block: 'sneak', params: { guardKind } }]), makePlayers(1, true), 3);
    playBots(rt, ['p0'], 0.7, 60);
    expect(rt.state).toBe('over');
    expect(total(rt)).toBeGreaterThan(0);
  });

  test('Ladoo Heist fixture (sneak + collect) plays with bots', () => {
    const spec = heist as unknown as GameSpec;
    const rt = runtime(spec, makePlayers(3, true), 5);
    playBots(rt, ['p0', 'p1', 'p2'], 0.6, 90);
    expect(rt.state).toBe('over');
    expect(total(rt)).toBeGreaterThan(0);
  });
});

// ---------- tug ----------

describe('tug', () => {
  const tugSpec = (params: Record<string, unknown> = {}) => makeSpec([{ block: 'tug', params }], 'tug', { teams: 2, win: { type: 'teamScore' } });
  const tap = (i: number, every: number) => ({ t: i, buttons: { pull: i % every < every / 2 } });

  test('requires teams: 2', () => {
    expect(() => runtime(makeSpec([{ block: 'tug', params: {} }], 'tug'), makePlayers(2))).toThrow(/teams/);
  });

  test('team with more taps wins by rope position', () => {
    const rt = runtime(tugSpec(), makePlayers(4));
    const rope = () => rt.snapshot().entities.find((e) => e.kind === 'rope')!;
    // team 0 = p0, p2 (tap every 6 steps); team 1 = p1, p3 (every 12)
    steps(rt, 3 * SPS, (i) => ({ p0: tap(i, 6), p2: tap(i, 6), p1: tap(i, 12), p3: tap(i, 12) }));
    expect(rope().props.pos as number).toBeLessThan(0);
    steps(rt, 30 * SPS, (i) => ({ p0: tap(i, 6), p2: tap(i, 6), p1: tap(i, 12), p3: tap(i, 12) }));
    const won = evs(rt, 'tug.won');
    expect(won.length).toBeGreaterThan(0);
    expect(won.every((e) => e.data!.team === 0)).toBe(true);
    expect(rt.result().winnerTeam).toBe(0);
  });

  test('uneven teams pull with equal per-player strength (averaged force)', () => {
    const players = makePlayers(3);
    players[0]!.team = 0;
    players[1]!.team = 1;
    players[2]!.team = 1;
    const rt = runtime(tugSpec({ fatigue: 0 }), players);
    steps(rt, 5 * SPS, (i) => ({ p0: tap(i, 8), p1: tap(i, 8), p2: tap(i, 8) }));
    const pos = rt.snapshot().entities.find((e) => e.kind === 'rope')!.props.pos as number;
    expect(Math.abs(pos)).toBeLessThan(0.05);
  });

  test('hold mode: holding pulls, fatigue drains stamina', () => {
    const rt = runtime(tugSpec({ mode: 'hold', fatigue: 0.5 }), makePlayers(2));
    steps(rt, 2 * SPS, (i) => ({ p0: { t: i, buttons: { pull: true } }, p1: { t: i } }));
    const snap = rt.snapshot();
    expect(snap.entities.find((e) => e.kind === 'rope')!.props.pos as number).toBeLessThan(0);
    expect(snap.entities.find((e) => e.owner === 'p0')!.props.stamina as number).toBeLessThan(1);
  });

  test('rhythm mode: on-beat taps beat off-beat taps', () => {
    const rt = runtime(tugSpec({ mode: 'rhythm', rhythmBpm: 120, fatigue: 0 }), makePlayers(2));
    // beat every 30 steps: p0 taps on the beat, p1 a quarter-beat late
    const beatTaps = (i: number) => ({ p0: { t: i, buttons: { pull: i % 30 < 3 } }, p1: { t: i, buttons: { pull: (i + 22) % 30 < 3 } } });
    steps(rt, 3 * SPS, beatTaps);
    expect(rt.snapshot().entities.find((e) => e.kind === 'rope')!.props.pos as number).toBeLessThan(-0.2);
    // mashing in rhythm mode is wasted effort: one pull per beat, and off-beat pulls are weak
    const mash = runtime(tugSpec({ mode: 'rhythm', rhythmBpm: 120, fatigue: 0 }), makePlayers(2));
    steps(mash, 3 * SPS, (i) => ({ p0: { t: i, buttons: { pull: i % 30 < 3 } }, p1: { t: i, buttons: { pull: i % 4 < 2 } } }));
    expect(mash.snapshot().entities.find((e) => e.kind === 'rope')!.props.pos as number).toBeLessThan(0);
  });

  test('live applyParams ropeLength keeps the rope fraction and awards no instant win', () => {
    const rt = runtime(tugSpec(), makePlayers(2));
    const rope = () => rt.snapshot().entities.find((e) => e.kind === 'rope')!;
    let i = 0;
    while ((rope().props.pos as number) > -0.5) {
      rt.input('p0', tap(i++, 6));
      rt.step();
    }
    const before = rope().props.pos as number;
    rt.applyParams(0, { ropeLength: 200 });
    rt.step();
    expect(evs(rt, 'tug.won')).toHaveLength(0);
    expect(Math.abs((rope().props.pos as number) - before)).toBeLessThan(0.05);
  });

  test('sudden death doubles the pull and is announced', () => {
    const rt = runtime(tugSpec({ suddenDeathAtSec: 5 }), makePlayers(2));
    steps(rt, 6 * SPS);
    expect(evs(rt, 'tug.suddenDeath')).toHaveLength(1);
    expect(rt.snapshot().entities.find((e) => e.kind === 'rope')!.props.suddenDeath).toBe(true);
  });

  test.each(['mash', 'rhythm', 'hold'] as const)('bots at skill 0.7 score > 0 in 60 s (%s)', (mode) => {
    const rt = runtime(tugSpec({ mode }), makePlayers(2, true), 3);
    // skill gap so one side wins bouts
    for (let i = 0; i < 60 * SPS && rt.state !== 'over'; i++) {
      rt.input('p0', rt.botInput('p0', 0.9));
      rt.input('p1', rt.botInput('p1', 0.3));
      rt.step();
    }
    expect(total(rt)).toBeGreaterThan(0);
  });
});

// ---------- draw-judge ----------

describe('draw-judge', () => {
  const PNG = 'data:image/png;base64,AAAA';
  const drawSpec = (params: Record<string, unknown> = {}) =>
    makeSpec([{ block: 'draw-judge', params: { drawSec: 20, rounds: 3, ...params } }], 'canvas', { durationSec: 120 });

  test('round waits for judgement and applies scores; times out after 12 s with equal scores', () => {
    const rt = runtime(drawSpec(), makePlayers(2));
    rt.input('p0', { t: 0, draw: PNG });
    rt.input('p1', { t: 0, draw: PNG });
    rt.step();
    rt.step(); // all submitted: drawing ends early
    const pj = rt.pendingJudgements();
    expect(pj).toHaveLength(1);
    expect(pj[0]!.kind).toBe('draw');
    const payload = pj[0]!.payload as { prompt: string; judgeStyle: string; entries: { playerId: string; image: string }[] };
    expect(payload.entries.map((e) => e.playerId)).toEqual(['p0', 'p1']);
    expect(payload.entries[0]!.image).toBe(PNG);
    expect(payload.judgeStyle).toBe('kind');

    // waits: no scores after 5 s
    steps(rt, 5 * SPS);
    expect(rt.result().ranking.every((p) => p.score === 0)).toBe(true);
    expect(rt.pendingJudgements()).toHaveLength(1);

    rt.resolveJudgement(pj[0]!.id, [
      { playerId: 'p0', score: 14, roast: 'A masterpiece of chaos.' },
      { playerId: 'p1', score: 3, roast: 'Bold use of nothing.' },
    ]);
    rt.step();
    const score = (id: string) => rt.result().ranking.find((p) => p.id === id)!.score;
    expect(score('p0')).toBe(10); // clamped
    expect(score('p1')).toBe(3);
    const judged = evs(rt, 'draw.judged');
    expect(judged.map((e) => [e.player, e.data!.roast])).toEqual([
      ['p0', 'A masterpiece of chaos.'],
      ['p1', 'Bold use of nothing.'],
    ]);

    // round 2: nobody resolves -> timeout after 12 s, equal scores
    let i = 0;
    while (rt.pendingJudgements().length === 0 && i++ < 10 * SPS) {
      rt.input('p0', { t: i, draw: PNG });
      rt.input('p1', { t: i, draw: PNG });
      rt.step();
    }
    expect(rt.pendingJudgements()).toHaveLength(1);
    steps(rt, 12 * SPS - 2);
    expect(evs(rt, 'draw.timeout')).toHaveLength(0);
    steps(rt, 2);
    expect(evs(rt, 'draw.timeout')).toHaveLength(1);
    expect(rt.pendingJudgements()).toHaveLength(0);
    expect(score('p0')).toBe(15);
    expect(score('p1')).toBe(8);
  });

  test('judgement entries flag bots so the backend can skip AI calls for them', () => {
    const players = [...makePlayers(1), { id: 'b1', name: 'Captain Crumbs', avatar: 'bot:0', isBot: true, connected: true, score: 0 }];
    const rt = runtime(drawSpec(), players);
    rt.input('p0', { t: 0, draw: PNG });
    rt.input('b1', { t: 0, draw: PNG });
    rt.step();
    rt.step();
    const entries = (rt.pendingJudgements()[0]!.payload as { entries: { playerId: string; bot: boolean }[] }).entries;
    expect(entries.map((e) => [e.playerId, e.bot])).toEqual([['p0', false], ['b1', true]]);
  });

  test('players who did not draw are not judged and score nothing', () => {
    const rt = runtime(drawSpec(), makePlayers(2));
    rt.input('p0', { t: 0, draw: PNG });
    steps(rt, 21 * SPS);
    const pj = rt.pendingJudgements();
    expect((pj[0]!.payload as { entries: unknown[] }).entries).toHaveLength(1);
    steps(rt, 9 * SPS);
    expect(rt.result().ranking.find((p) => p.id === 'p1')!.score).toBe(0);
  });

  test('live applyParams drawSec ends the drawing phase if already past the new limit', () => {
    const rt = runtime(drawSpec({ drawSec: 40 }), makePlayers(2));
    rt.input('p0', { t: 0, draw: PNG });
    steps(rt, 15 * SPS);
    expect(rt.pendingJudgements()).toHaveLength(0);
    rt.applyParams(0, { drawSec: 10 });
    rt.step();
    expect(rt.pendingJudgements()).toHaveLength(1);
  });

  test('bots draw and score > 0 (timeout path and stub judge path)', () => {
    const a = runtime(drawSpec(), makePlayers(2, true), 3);
    playBots(a, ['p0', 'p1'], 0.7, 120);
    expect(total(a)).toBeGreaterThan(0);
    const b = runtime(drawSpec(), makePlayers(2, true), 3);
    playBots(b, ['p0', 'p1'], 0.7, 120, true);
    expect(total(b)).toBeGreaterThan(0);
    expect(evs(b, 'draw.judged').length).toBeGreaterThan(0);
  });
});

// ---------- trivia ----------

describe('trivia', () => {
  const Q = [
    { q: 'Two plus two?', options: ['3', '4', '5', '22'], answer: 1 },
    { q: 'Colour of the sky?', options: ['Green', 'Red', 'Blue', 'Plaid'], answer: 2 },
  ];
  const triviaSpec = (params: Record<string, unknown> = {}) =>
    makeSpec([{ block: 'trivia', params: { questions: Q, secondsPerQuestion: 12, pointsFast: 3, pointsSlow: 1, ...params } }], 'quiz');

  test('faster correct answer gets pointsFast', () => {
    const rt = runtime(triviaSpec(), makePlayers(3));
    steps(rt, 1 * SPS);
    rt.input('p0', { t: 0, vote: 1 });
    steps(rt, 7 * SPS);
    rt.input('p1', { t: 1, vote: 1 });
    rt.input('p2', { t: 1, vote: 0 });
    steps(rt, 5 * SPS);
    const score = (id: string) => rt.result().ranking.find((p) => p.id === id)!.score;
    expect(score('p0')).toBe(3);
    expect(score('p1')).toBe(1);
    expect(score('p2')).toBe(0);
  });

  test('first answer locks; question ends early when everyone answered', () => {
    const rt = runtime(triviaSpec(), makePlayers(2));
    rt.input('p0', { t: 0, vote: 0 });
    rt.input('p1', { t: 0, vote: 1 });
    rt.step();
    rt.input('p0', { t: 1, vote: 1 });
    steps(rt, 4 * SPS);
    const score = (id: string) => rt.result().ranking.find((p) => p.id === id)!.score;
    expect(score('p0')).toBe(0);
    expect(score('p1')).toBe(3);
    expect(evs(rt, 'trivia.reveal').length).toBe(1);
  });

  test('board never exposes the answer before the reveal', () => {
    const rt = runtime(triviaSpec(), makePlayers(1));
    rt.step();
    const board = rt.snapshot().entities.find((e) => e.kind === 'quiz')!;
    expect(board.props.q).toBe('Two plus two?');
    expect(board.props.opt1).toBe('4');
    expect(board.props.answer).toBe(-1);
  });

  test('empty questions: requests trivia-gen, shows Thinking..., uses AI questions when resolved', () => {
    const rt = runtime(makeSpec([{ block: 'trivia', params: {} }], 'quiz', { title: 'Pizza Cats' }), makePlayers(2));
    const pj = rt.pendingJudgements();
    expect(pj).toHaveLength(1);
    expect(pj[0]!.kind).toBe('trivia-gen');
    const payload = pj[0]!.payload as { topic: string; ingredients: string[]; players: string[]; n: number };
    expect(payload.topic).toBe('Pizza Cats');
    expect(payload.ingredients).toEqual(['cats', 'pizza']);
    expect(payload.players).toEqual(['P0', 'P1']);
    expect(payload.n).toBeGreaterThan(0);
    rt.step();
    expect(rt.snapshot().entities.find((e) => e.kind === 'quiz')!.props.banner).toBe('Thinking…');
    steps(rt, 2 * SPS);
    rt.resolveJudgement(pj[0]!.id, [...Q, { q: 'bad', options: ['only one'], answer: 9 }]);
    steps(rt, 2);
    const board = rt.snapshot().entities.find((e) => e.kind === 'quiz')!;
    expect(board.props.q).toBe('Two plus two?');
    expect(evs(rt, 'trivia.generated')[0]!.data!.source).toBe('ai');
  });

  test('empty questions: falls back to the built-in bank after 8 s', () => {
    expect(FALLBACK_QUESTIONS.length).toBeGreaterThanOrEqual(10);
    const rt = runtime(makeSpec([{ block: 'trivia', params: {} }], 'quiz'), makePlayers(1));
    steps(rt, 8 * SPS - 1);
    expect(evs(rt, 'trivia.generated')).toHaveLength(0);
    steps(rt, 2);
    expect(evs(rt, 'trivia.generated')[0]!.data!.source).toBe('fallback');
    expect(rt.pendingJudgements()).toHaveLength(0);
    const q = rt.snapshot().entities.find((e) => e.kind === 'quiz')!.props.q;
    expect(FALLBACK_QUESTIONS.map((f) => f.q)).toContain(q);
  });

  test('live applyParams secondsPerQuestion ends a question already past the new limit', () => {
    const rt = runtime(triviaSpec({ secondsPerQuestion: 20 }), makePlayers(2));
    steps(rt, 8 * SPS);
    expect(evs(rt, 'trivia.reveal')).toHaveLength(0);
    rt.applyParams(0, { secondsPerQuestion: 5 });
    rt.step();
    expect(evs(rt, 'trivia.reveal')).toHaveLength(1);
  });

  test('bots answer correctly with probability = skill', () => {
    const rate = (skill: number) => {
      let right = 0, all = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const rt = runtime(makeSpec([{ block: 'trivia', params: { questions: FALLBACK_QUESTIONS.slice(0, 10) } }], 'quiz'), makePlayers(4, true), seed);
        playBots(rt, ['p0', 'p1', 'p2', 'p3'], skill, 60);
        for (const e of evs(rt, 'trivia.answer')) {
          all++;
          if (e.data!.correct) right++;
        }
      }
      return right / all;
    };
    expect(rate(0.9)).toBeGreaterThan(0.75);
    expect(rate(0.3)).toBeLessThan(0.5);
  });

  test('bot at skill 0.7 scores > 0 in 60 s (no resolver: fallback bank)', () => {
    const rt = runtime(makeSpec([{ block: 'trivia', params: {} }], 'quiz'), makePlayers(1, true), 3);
    playBots(rt, ['p0'], 0.7, 60);
    expect(rt.state).toBe('over');
    expect(total(rt)).toBeGreaterThan(0);
  });
});
