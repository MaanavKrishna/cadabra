import { beforeAll, describe, expect, test, vi } from 'vitest';

vi.mock('pixi.js', () => import('./pixi-mock'));

import { fakeDocument, type Container, type RenderTexture } from './pixi-mock';
import { BackgroundBake, EdgeGlow } from '../src/background';

beforeAll(() => fakeDocument());

describe('background bake', () => {
  test('bakes once, then only again after invalidate (theme change), never per frame', () => {
    const calls: { stack: Container; target: RenderTexture; tx: number; ty: number }[] = [];
    const bake = new BackgroundBake(1280, 720, 40, (stack, target, tf) => {
      calls.push({ stack: stack as unknown as Container, target: target as unknown as RenderTexture, tx: (tf as unknown as { tx: number }).tx, ty: (tf as unknown as { ty: number }).ty });
    });
    for (let f = 0; f < 120; f++) bake.ensure();
    expect(bake.bakes).toBe(1);
    expect(calls).toHaveLength(1);
    // covers the shake pad on every side, offset so the stack's -pad origin lands at 0
    expect(calls[0]!.target.width).toBe(1360);
    expect(calls[0]!.target.height).toBe(800);
    expect(calls[0]!.tx).toBe(40);
    expect(calls[0]!.ty).toBe(40);
    expect(bake.sprite.texture).toBe(calls[0]!.target);

    bake.invalidate(); // new theme / palette / floor
    expect(bake.ensure()).toBe(true);
    for (let f = 0; f < 120; f++) expect(bake.ensure()).toBe(false);
    expect(bake.bakes).toBe(2);
    // the same render texture is reused (no per-theme GPU allocation)
    expect(calls[1]!.target).toBe(calls[0]!.target);
  });

  test('the on-screen quad is drawn without blending', () => {
    const bake = new BackgroundBake(1280, 720, 40, () => {});
    expect(bake.sprite.blendMode).toBe('none');
    expect(bake.sprite.position.x).toBe(-40);
  });
});

describe('edge glow', () => {
  test('is four border strips, hidden (free) at zero alpha', () => {
    const g = new EdgeGlow(1280, 720, 110);
    expect(g.root.children).toHaveLength(4);
    expect(g.visible).toBe(false);
    g.set(0.3, 0xff0000);
    expect(g.visible).toBe(true);
    for (const s of g.root.children) expect((s as unknown as { tint: number }).tint).toBe(0xff0000);
    g.set(0, 0xff0000);
    expect(g.visible).toBe(false);
  });
});
