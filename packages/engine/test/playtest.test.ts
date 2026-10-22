import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { BlockUse, ControlWidget, GameSpec } from '@cadabra/spec';
import {
  BOT_NAMES, BlockRegistry, GameRuntime, Rng, driveBots, kitCatalog, makeBots, playtest, registerBuiltins,
  type BlockDef,
} from '../src/index';
import heistJson from '../../spec/test/fixtures/heist.json';

const heist = heistJson as unknown as GameSpec;

function reg(extra: BlockDef[] = []): BlockRegistry {
  const r = new BlockRegistry();
  registerBuiltins(r);
  for (const d of extra) r.register(d);
  return r;
}

function makeSpec(
  blocks: BlockUse[],
  controller: ControlWidget[] = [{ kind: 'joystick', id: 'move' }],
  over: Partial<GameSpec> = {},
): GameSpec {
  return {
    ...heist,
    id: 'playtest',
    arena: { kind: 'topdown', width: 1280, height: 720 },
    durationSec: 60,
    blocks,
    modifiers: [],
    win: { type: 'highScore' },
    timeline: [{ atSec: 30, kind: 'surprise', params: {}, hostLine: 'Surprise!' }],
    controller,
    ...over,
  };
}

function stub(id: string, hooks: Partial<BlockDef> = {}): BlockDef {
  return {
    id,
    name: id,
    summary: 'test only',
    paramsSchema: z.object({}),
    defaults: {},
    controls: [],
    arenaKinds: ['topdown'],
    setup() {},
    update() {},
    onInput() {},
    bot() {
      return { t: 0 };
    },
    ...hooks,
  };
}

const has = (reasons: string[], ...parts: string[]) => reasons.some((r) => parts.every((p) => r.includes(p)));

describe('playtest (brief)', () => {
  test('heist fixture passes', () => {
    const r = playtest(heist, reg());
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.stats.scoringPlayers).toBeGreaterThanOrEqual(2);
    expect(r.stats.endedAtSec).toBeCloseTo(heist.durationSec, 1);
    expect(r.stats.events).toBeGreaterThan(0);
    expect(r.stats.maxEntities).toBeGreaterThan(4);
  });

  test('spec with dodge rampPerSec 50 fails with reason containing "scoringPlayers"', () => {
    // rampPerSec 50 is outside the schema (max 0.5): rejected before the round, naming the param
    const wild = playtest(makeSpec([{ block: 'dodge', params: { rampPerSec: 50, onHit: 'eliminate' } }]), reg());
    expect(wild.ok).toBe(false);
    expect(has(wild.reasons, 'dodge', 'rampPerSec')).toBe(true);
    // the legal worst case: hazards ramp at max, every hit eliminates and nothing pays out
    const deadly = makeSpec([
      {
        block: 'dodge',
        params: { rampPerSec: 0.5, startRate: 10, maxRate: 20, onHit: 'eliminate', survivePoints: 0, nearMissPoints: 0, pattern: 'rain' },
      },
    ]);
    const r = playtest(deadly, reg());
    expect(r.ok).toBe(false);
    expect(r.stats.scoringPlayers).toBeLessThan(2);
    expect(has(r.reasons, 'scoringPlayers')).toBe(true);
  });

  test('missing joystick widget for arena-move fails', () => {
    const spec = makeSpec(
      [{ block: 'arena-move', params: {} }, { block: 'collect', params: {} }],
      [{ kind: 'button', id: 'dash', label: 'Dash' }],
    );
    const r = playtest(spec, reg());
    expect(r.ok).toBe(false);
    expect(has(r.reasons, 'arena-move', 'joystick')).toBe(true);
    // tilt steering needs a tilt widget instead
    const tilt = makeSpec([{ block: 'arena-move', params: { input: 'tilt' } }, { block: 'collect', params: {} }]);
    expect(has(playtest(tilt, reg()).reasons, 'arena-move', 'tilt')).toBe(true);
  });

  test('full 120 s round finishes in < 3000 ms wall', () => {
    const spec = makeSpec(
      [
        { block: 'arena-move', params: {} },
        { block: 'collect', params: {} },
        { block: 'dodge', params: { pattern: 'ring' } },
      ],
      [
        { kind: 'joystick', id: 'move' },
        { kind: 'button', id: 'dash', label: 'Dash' },
      ],
      { durationSec: 120, timeline: [{ atSec: 60, kind: 'surprise', params: {}, hostLine: 'Surprise!' }] },
    );
    const r = playtest(spec, reg());
    expect(r.reasons).toEqual([]);
    expect(r.stats.endedAtSec).toBeCloseTo(120, 1);
    expect(r.stats.msWall).toBeLessThan(3000);
  });

  test('catalog lists 8 blocks with JSON schemas', () => {
    const cat = kitCatalog(reg());
    expect(cat.map((k) => k.id)).toEqual(['arena-move', 'collect', 'dodge', 'race', 'sneak', 'tug', 'draw-judge', 'trivia']);
    const registry = reg();
    for (const k of cat) {
      const def = registry.get(k.id)!;
      expect(k.name).toBe(def.name);
      expect(k.summary).toBe(def.summary);
      expect(k.controls).toEqual(def.controls);
      expect(k.arenaKinds).toEqual(def.arenaKinds);
      const schema = k.params as { type: string; properties: Record<string, { default?: unknown; description?: string }>; required: string[] };
      expect(schema.type).toBe('object');
      expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(def.defaults as object).sort());
      for (const [key, prop] of Object.entries(schema.properties)) {
        expect(prop.default, `${k.id}.${key} default`).toEqual((def.defaults as Record<string, unknown>)[key]);
        expect(prop.description, `${k.id}.${key} description`).toBeTruthy();
      }
    }
    // the catalog is plain JSON (what the AI designer receives)
    expect(JSON.parse(JSON.stringify(cat))).toEqual(cat);
  });
});

describe('playtest (gate rules)', () => {
  test('duplicate controller widget ids fail', () => {
    const spec = { ...heist, controller: [...heist.controller, { kind: 'button', id: 'grab', label: 'Grab 2' } as ControlWidget] };
    const r = playtest(spec, reg());
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('duplicate controller widget id: grab');
  });

  test('sneak needs a hold/button widget named like tiptoeButton', () => {
    const spec = { ...heist, controller: heist.controller.filter((w) => w.id !== 'tiptoe') };
    const r = playtest(spec, reg());
    expect(r.ok).toBe(false);
    expect(has(r.reasons, 'sneak', 'tiptoe')).toBe(true);
  });

  test('spec that fails parseSpec fails with the schema errors', () => {
    const r = playtest({ ...heist, durationSec: 30 }, reg());
    expect(r.ok).toBe(false);
    expect(has(r.reasons, 'spec', 'durationSec')).toBe(true);
  });

  test('unknown block fails', () => {
    const r = playtest(makeSpec([{ block: 'teleport', params: {} }]), reg());
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('unknown block: teleport');
  });

  test('block arenaKinds must include the arena kind', () => {
    const r = playtest(makeSpec([{ block: 'collect', params: {} }], undefined, { arena: { kind: 'lanes', width: 1280, height: 720 } }), reg());
    expect(r.ok).toBe(false);
    expect(has(r.reasons, 'collect', 'lanes')).toBe(true);
  });

  test('a block throwing in setup fails with block id and message', () => {
    const boom = stub('boom', {
      setup() {
        throw new Error('kaboom');
      },
    });
    const r = playtest(makeSpec([{ block: 'collect', params: {} }, { block: 'boom', params: {} }]), reg([boom]));
    expect(r.ok).toBe(false);
    expect(has(r.reasons, 'boom', 'setup', 'kaboom')).toBe(true);
  });

  test('tug with teams 0 surfaces the setup error', () => {
    const spec = makeSpec([{ block: 'tug', params: {} }], [{ kind: 'button', id: 'pull', label: 'Pull' }], {
      arena: { kind: 'tug', width: 1280, height: 720 },
    });
    const r = playtest(spec, reg());
    expect(r.ok).toBe(false);
    expect(has(r.reasons, 'tug', 'teams: 2')).toBe(true);
    expect(playtest({ ...spec, teams: 2 }, reg()).reasons).toEqual([]);
  });

  test('an exception mid-round fails with block id, hook and sim time', () => {
    const late = stub('late', {
      update(ctx) {
        if (ctx.time > 5) throw new Error('fell over');
      },
    });
    const r = playtest(makeSpec([{ block: 'collect', params: {} }, { block: 'late', params: {} }]), reg([late]));
    expect(r.ok).toBe(false);
    expect(has(r.reasons, 'late', 'update', 'fell over')).toBe(true);
    expect(r.stats.endedAtSec).toBeGreaterThan(5);
    expect(r.stats.endedAtSec).toBeLessThan(6);
  });

  test('ending before 80% of durationSec fails unless the win type ends early by design', () => {
    const tugSpec = (win: GameSpec['win']) =>
      makeSpec([{ block: 'tug', params: {} }], [{ kind: 'button', id: 'pull', label: 'Pull' }], {
        arena: { kind: 'tug', width: 1280, height: 720 },
        teams: 2,
        win,
      });
    const early = playtest(tugSpec({ type: 'teamScore', target: 1 }), reg());
    expect(early.ok).toBe(false);
    expect(early.stats.endedAtSec).toBeLessThan(48);
    expect(has(early.reasons, 'ended')).toBe(true);
    const first = playtest(tugSpec({ type: 'firstTo', target: 3 }), reg());
    expect(first.stats.endedAtSec).toBeLessThan(48);
    expect(first.reasons).toEqual([]);
  });

  test('more than 400 entities fails', () => {
    const swarm = stub('swarm', {
      setup(ctx) {
        for (let i = 0; i < 450; i++) ctx.world.spawn('dot', 10, 10);
      },
    });
    const r = playtest(makeSpec([{ block: 'collect', params: {} }, { block: 'swarm', params: {} }]), reg([swarm]));
    expect(r.ok).toBe(false);
    expect(r.stats.maxEntities).toBeGreaterThan(400);
    expect(has(r.reasons, 'maxEntities')).toBe(true);
  });

  test('wall time over 3000 ms fails (injectable clock)', () => {
    let t = 0;
    const r = playtest(heist, reg(), { now: () => (t += 500) });
    expect(r.ok).toBe(false);
    expect(r.stats.msWall).toBeGreaterThan(3000);
    expect(has(r.reasons, 'wall time')).toBe(true);
    // a fast fake clock passes and reports its exact reading
    let u = 0;
    const ok = playtest(heist, reg(), { now: () => (u += 0.001) });
    expect(ok.ok).toBe(true);
    expect(ok.stats.msWall).toBeLessThan(1);
  });

  test.each([
    ['draw-judge', 'canvas', [{ kind: 'draw', id: 'pad', prompt: 'Draw it' }]],
    ['trivia', 'quiz', [{ kind: 'vote', id: 'answer', options: ['A', 'B', 'C', 'D'] }]],
    ['race', 'lanes', [{ kind: 'button', id: 'run', label: 'Run' }, { kind: 'button', id: 'jump', label: 'Jump' }]],
  ] as const)('%s round passes with stub-resolved judgements', (block, kind, controller) => {
    const spec = makeSpec([{ block, params: {} }], [...controller] as ControlWidget[], {
      arena: { kind, width: 1280, height: 720 },
      durationSec: 90,
    });
    const r = playtest(spec, reg());
    expect(r.reasons).toEqual([]);
  });

  test('race without a jump widget fails (obstacles need jumping)', () => {
    const spec = makeSpec([{ block: 'race', params: {} }], [{ kind: 'button', id: 'run', label: 'Run' }], {
      arena: { kind: 'lanes', width: 1280, height: 720 },
    });
    expect(has(playtest(spec, reg()).reasons, 'race', 'jump')).toBe(true);
  });

  test('deterministic: same seed, same stats (wall time aside)', () => {
    const a = playtest(heist, reg(), { seed: 7 });
    const b = playtest(heist, reg(), { seed: 7 });
    expect({ ...a.stats, msWall: 0 }).toEqual({ ...b.stats, msWall: 0 });
  });
});

describe('bots', () => {
  test('makeBots: fun unique names, bot avatars, deterministic', () => {
    const bots = makeBots(4, new Rng(3));
    expect(bots).toHaveLength(4);
    expect(new Set(bots.map((b) => b.name)).size).toBe(4);
    expect(new Set(bots.map((b) => b.id)).size).toBe(4);
    for (const b of bots) {
      expect(BOT_NAMES).toContain(b.name);
      expect(b.avatar).toMatch(/^bot:\d+$/);
      expect(b).toMatchObject({ isBot: true, connected: true, score: 0 });
    }
    expect(makeBots(4, new Rng(3))).toEqual(bots);
    expect(makeBots(BOT_NAMES.length + 2, new Rng(1))).toHaveLength(BOT_NAMES.length + 2);
  });

  test('driveBots feeds one botInput per bot per step (same as driving by hand)', () => {
    const bots = makeBots(3, new Rng(1));
    const byHand = new GameRuntime(heist, bots, reg(), 4);
    const driven = new GameRuntime(heist, bots, reg(), 4);
    for (let i = 0; i < 600; i++) {
      for (const b of bots) byHand.input(b.id, byHand.botInput(b.id, 0.7));
      byHand.step();
      driveBots(driven, bots, 0.7);
      driven.step();
    }
    expect(driven.events).toEqual(byHand.events);
    expect(driven.result().ranking.some((p) => p.score > 0)).toBe(true);
  });
});
