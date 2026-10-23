import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { Entity, Player } from '@cadabra/engine';

vi.mock('pixi.js', () => import('./pixi-mock'));

import { fakeDocument } from './pixi-mock';
import { EntityLayer, type FrameCtx } from '../src/entities';
import { NEON, NEON_KEYS, NeonArt, blinkOpen, eyeLook, fuseLeft, fusePulseHz, gridRows, neonKey, scrollPhase } from '../src/neon';
import { TextureStore, type Img } from '../src/textures';
import { TEAM_COLORS, playerColor } from '../src/theme';
import { MUSIC_STYLES, renderLoop } from '../src/music';

beforeAll(() => fakeDocument());

describe('neon art keys', () => {
  test('contract keys map to themselves', () => {
    // 'goal' as a sprite stays the collect block's base zone; the net goal is 'net'
    for (const k of NEON_KEYS) if (k !== 'goal') expect(neonKey(k, 'item')).toBe(k);
    expect(neonKey('goal', 'goal')).toBe('base');
    expect(neonKey('net', 'goal')).toBe('goal');
    expect(neonKey('goal-net', 'goal')).toBe('goal');
  });
  test('unknown keys fall back by entity kind', () => {
    expect(neonKey('mystery', 'item')).toBe('gem');
    expect(neonKey('mystery', 'pickup')).toBe('gem');
    expect(neonKey('mystery', 'hazard')).toBe('spike');
    expect(neonKey('mystery', 'goal')).toBe('base');
    expect(neonKey('mystery', 'base')).toBe('base');
    expect(neonKey('mystery', 'boost-pad')).toBe('boost');
    expect(neonKey('mystery', 'whatever')).toBe('gem');
    expect(neonKey(undefined, undefined)).toBe('gem');
  });
  test('free-form keys pick a neon look by word', () => {
    expect(neonKey('pizza-core', 'item')).toBe('core');
    expect(neonKey('overload-bomb', 'item')).toBe('core-unstable');
    expect(neonKey('lava-blob', 'hazard')).toBe('spike');
    expect(neonKey('laser-gate', 'obstacle')).toBe('laser');
    expect(neonKey('avatar:p1', 'player')).toBe('player');
    // players and tiles keep their look whatever the sprite says
    expect(neonKey('gem-hat', 'player')).toBe('player');
  });
});

describe('neon motion math', () => {
  test('fuse: seconds left from props, absolute or relative', () => {
    expect(fuseLeft({ fuseLeft: 3 }, 10)).toBe(3);
    expect(fuseLeft({ fuseAt: 14 }, 10)).toBe(4);
    expect(fuseLeft({ detonateAt: 9 }, 10)).toBe(0);
    expect(fuseLeft({}, 10)).toBeUndefined();
  });
  test('the core pulses faster as the fuse runs out', () => {
    expect(fusePulseHz(8)).toBeCloseTo(1.5);
    expect(fusePulseHz(0)).toBe(10);
    expect(fusePulseHz(2)).toBeGreaterThan(fusePulseHz(6));
    expect(fusePulseHz(undefined)).toBeGreaterThan(0);
  });
  test('eyes look along the motion, capped', () => {
    const o = { x: 0, y: 0 };
    eyeLook(300, 0, 5, o);
    expect(o).toEqual({ x: 5, y: 0 });
    eyeLook(0, -40, 5, o);
    expect(o.y).toBeLessThan(0);
    expect(Math.abs(o.y)).toBeLessThanOrEqual(5);
    eyeLook(0, 0, 5, o);
    expect(o.x).toBe(0);
  });
  test('blinks are short and periodic', () => {
    let closed = 0;
    for (let i = 0; i < 6000; i++) if (blinkOpen(i / 1000, 3) < 0.5) closed++;
    expect(closed).toBeGreaterThan(40);
    expect(closed).toBeLessThan(300);
  });
  test('scroll phase wraps into 0..1 and spreads chevrons', () => {
    for (const t of [0, 0.3, 7.9, -1.2]) {
      const v = scrollPhase(t, 1.6, 1, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(scrollPhase(0, 1, 1, 3) - scrollPhase(0, 1, 0, 3)).toBeCloseTo(1 / 3);
  });
  test('perspective grid rows bunch toward the far edge', () => {
    const r = gridRows(0, 100, 4);
    expect(r[0]).toBe(0);
    expect(r[4]).toBe(100);
    expect(r[1]! - r[0]!).toBeLessThan(r[4]! - r[3]!);
  });
  test('player and team colours are the neon set', () => {
    expect([0, 1, 2, 3].map((i) => playerColor(i))).toEqual([NEON.cyan, NEON.magenta, NEON.lime, NEON.amber]);
    expect(TEAM_COLORS).toEqual([NEON.cyan, NEON.magenta]);
  });
  test('the neon music style renders a loud, finite loop', () => {
    const { base } = renderLoop(MUSIC_STYLES.neon!, 8000);
    let peak = 0;
    for (const v of base) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThan(0.3);
  });
});

describe('neon entity views', () => {
  const players: Player[] = [0, 1].map((i) => ({ id: `p${i}`, name: `P${i}`, avatar: `bot:${i}`, isBot: true, connected: true, score: 0 }));
  const ctx = (vt: number): FrameCtx => ({
    palette: { bg: '#0A0E27', primary: '#00E5FF', accent: '#FF2BD6', glow: '#B6FF3B', text: '#FFFFFF' },
    art: {}, defaults: {}, players: new Map(players.map((p) => [p.id, p])), playerIndex: new Map(players.map((p, i) => [p.id, i])),
    time: vt, vt, dt: 1 / 60, degraded: false,
  });
  const e = (id: number, kind: string, sprite: string, props: Entity['props'] = {}, o: Partial<Entity> = {}): Entity => ({
    id, kind, x: 100 + id * 40, y: 300, vx: 0, vy: 0, r: 20, sprite, tags: new Set(), props, ...o,
  });
  const particles = { emit: () => 0, one: () => undefined, budget: { active: 0, cap: 250 } };

  test('every neon key draws without the art pack, and spike views never come back as lasers', () => {
    const store = new TextureStore({ loadImage: async () => ({ naturalWidth: 64, naturalHeight: 64 }) as Img });
    const layer = new EntityLayer(store, particles as never, 1280, 720, new NeonArt());
    const pos = (x: Entity) => x;
    const all = [
      e(1, 'player', 'avatar:p0', { dashing: true }, { owner: 'p0' }), e(2, 'player', 'avatar:p1', {}, { owner: 'p1', team: 1 }),
      e(3, 'item', 'gem', { carriedBy: '' }), e(4, 'core', 'core-unstable', { holder: 'p0', fuseLeft: 2, pulseHz: 6 }),
      e(5, 'hazard', 'spike'), e(6, 'obstacle', 'laser', { lane: 1, armed: false }), e(7, 'boost-pad', 'boost'),
      e(8, 'base', 'base', {}, { team: 0 }), e(9, 'tile', 'tile', { hw: 30, hh: 30, paintTeam: 1 }), e(10, 'hazard', 'hole'),
      e(11, 'finish', 'finish', { hh: 360, hw: 6 }),
    ];
    for (let f = 0; f < 5; f++) layer.sync(all, pos, ctx(f / 60));
    for (const x of all) if (x.kind !== 'tile') expect(layer.rootOf(x.id)).toBeDefined();
    // a spike dies; a laser hazard arrives: it must get a fresh view
    const spikeRoot = layer.rootOf(5)!;
    layer.sync([], pos, ctx(1));
    layer.sync([], pos, ctx(2));
    layer.sync([e(12, 'hazard', 'laser')], pos, ctx(3));
    expect(layer.rootOf(12)).not.toBe(spikeRoot);
  });
});
