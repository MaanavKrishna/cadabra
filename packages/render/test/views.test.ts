import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { Entity } from '@cadabra/engine';

vi.mock('pixi.js', () => import('./pixi-mock'));

import { fakeDocument } from './pixi-mock';
import { EntityLayer, type FrameCtx } from '../src/entities';
import { resolveSprite } from '../src/sprites';
import { TextureStore, type Img } from '../src/textures';

beforeAll(() => fakeDocument());

const palette = { bg: '#101030', primary: '#4cc9f0', accent: '#f72585', glow: '#ffd166', text: '#ffffff' } as const;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('texture cache is keyed by url', () => {
  test('a second theme with a different url for the same key uses the new texture', async () => {
    const store = new TextureStore({ loadImage: async () => ({ naturalWidth: 128, naturalHeight: 128 }) as Img });
    const fb = { type: 'shape', shape: 'orb', color: '#fff', accent: '#000' } as const;
    const game1 = resolveSprite('item', { art: { item: 'https://cdn/g1/item.png' }, defaults: {}, palette });
    store.beginTheme(['https://cdn/g1/item.png']);
    await store.load('https://cdn/g1/item.png', undefined, true);
    const t1 = store.get(game1, fb);

    const game2 = resolveSprite('item', { art: { item: 'https://cdn/g2/item.png' }, defaults: {}, palette });
    expect(game2.type === 'url' && game2.key).not.toBe(game1.type === 'url' && game1.key);
    store.beginTheme(['https://cdn/g2/item.png']);
    await store.load('https://cdn/g2/item.png', undefined, true);
    const t2 = store.get(game2, fb);
    expect(t2).not.toBe(t1);
    expect(store.loaded('https://cdn/g2/item.png')).toBe(t2);
    // game 1's art is evicted (and freed) once game 2 no longer lists it
    expect(store.loaded('https://cdn/g1/item.png')).toBeUndefined();
    expect((t1 as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  test('a failure in game 1 does not block game 2', async () => {
    let fail = true;
    const store = new TextureStore({
      loadImage: async () => {
        if (fail) throw new Error('offline');
        return { naturalWidth: 64, naturalHeight: 64 } as Img;
      },
    });
    const url = 'https://cdn/shared/guard.png';
    store.beginTheme([url]);
    expect(await store.load(url, undefined, true)).toBeNull();
    expect(await store.load(url, undefined, true)).toBeNull(); // remembered within the theme
    fail = false;
    store.beginTheme([url]);
    expect(await store.load(url, undefined, true)).not.toBeNull();
    // and a brand-new url is never blocked by an old failure
    expect(await store.load('https://cdn/g2/guard.png', undefined, true)).not.toBeNull();
  });

  test('loads that resolve after destroy are discarded', async () => {
    let release!: (i: Img) => void;
    const store = new TextureStore({ loadImage: () => new Promise<Img>((r) => (release = r)) });
    const p = store.load('https://cdn/late.png');
    store.destroy();
    release({ naturalWidth: 64, naturalHeight: 64 });
    expect(await p).toBeNull();
    expect(store.loaded('https://cdn/late.png')).toBeUndefined();
  });
});

describe('entity views are pooled', () => {
  const ctx = (vt: number): FrameCtx => ({
    palette, art: {}, defaults: {}, players: new Map(), playerIndex: new Map(), time: vt, vt, dt: 1 / 60, degraded: false,
  });
  const hazard = (id: number, x: number): Entity => ({
    id, kind: 'hazard', x, y: 300, vx: 0, vy: 0, r: 22, sprite: 'hazard', tags: new Set(),
    props: { armed: false, warnMs: 700, armAt: 10, ax: 300, ay: 0 },
  });
  const particles = { emit: () => 0, one: () => undefined, budget: { active: 0, cap: 250 } };

  test('a removed hazard view is reused for the next hazard, reset', async () => {
    const store = new TextureStore({ loadImage: async () => ({ naturalWidth: 64, naturalHeight: 64 }) as Img });
    const layer = new EntityLayer(store, particles as never, 1280, 720);
    const pos = (e: Entity) => e;
    layer.sync([hazard(1, 100)], pos, ctx(0));
    const root = layer.rootOf(1)!;
    expect(layer.stats).toEqual({ created: 1, reused: 0 });
    layer.sync([], pos, ctx(0.1)); // dying
    layer.sync([], pos, ctx(1)); // die-out done -> pooled, hidden
    expect(root.visible).toBe(false);
    layer.sync([hazard(2, 500)], pos, ctx(2));
    expect(layer.rootOf(2)).toBe(root);
    expect(layer.stats).toEqual({ created: 1, reused: 1 });
    expect(root.visible).toBe(true);
    expect(root.alpha).toBe(1);
    expect(root.x).toBe(500);
    await tick();
  });

  test('views of different kinds never share a pool', () => {
    const store = new TextureStore({ loadImage: async () => ({ naturalWidth: 64, naturalHeight: 64 }) as Img });
    const layer = new EntityLayer(store, particles as never, 1280, 720);
    const pos = (e: Entity) => e;
    layer.sync([hazard(1, 100)], pos, ctx(0));
    layer.sync([], pos, ctx(0.1));
    layer.sync([], pos, ctx(1));
    const item: Entity = { ...hazard(3, 200), kind: 'item', sprite: 'item', props: {} };
    layer.sync([item], pos, ctx(2));
    expect(layer.stats).toEqual({ created: 2, reused: 0 });
  });
});
