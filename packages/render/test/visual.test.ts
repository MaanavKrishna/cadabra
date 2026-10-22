import { describe, expect, test, vi } from 'vitest';
import type { Theme } from '@cadabra/spec';

vi.mock('pixi.js', () => ({}));

import { AVATAR_ART, DEFAULT_SPRITES, avatarArtFor, resolveSprite } from '../src/sprites';
import { SnapInterp, avatarFx, guardVisual, lerpPos, telegraphState } from '../src/visual';

const palette: Theme['palette'] = { bg: '#101030', primary: '#4cc9f0', accent: '#f72585', glow: '#ffd166', text: '#ffffff' };
const defaults: Record<string, string> = {
  coin: 'u/coin.png', fireball: 'u/fireball.png', 'bear-sleep': 'u/bear-sleep.png', 'bear-awake': 'u/bear-awake.png',
  'robot-patrol': 'u/robot.png', 'avatar-cat': 'u/cat.png', 'avatar-fox': 'u/fox.png', ladoo: 'u/ladoo.png',
};

describe('sprite resolution', () => {
  test('theme art overrides defaults, defaults map engine keys, pack names resolve directly', () => {
    expect(DEFAULT_SPRITES.item).toBe('coin');
    expect(DEFAULT_SPRITES.guard).toBe('bear-sleep');
    expect(resolveSprite('item', { art: {}, defaults, palette, kind: 'item' })).toEqual({ type: 'url', url: 'u/coin.png', key: 'coin' });
    expect(resolveSprite('item', { art: { item: 'https://cdn/x.png' }, defaults, palette, kind: 'item' })).toEqual({
      type: 'url', url: 'https://cdn/x.png', key: 'art:item|https://cdn/x.png',
    });
    expect(resolveSprite('ladoo', { art: {}, defaults, palette, kind: 'item' })).toMatchObject({ url: 'u/ladoo.png' });
  });

  test('guards switch to their awake art; patrol guards default to the robot', () => {
    const o = { art: {}, defaults, palette, kind: 'guard' };
    expect(resolveSprite('guard', { ...o, variant: 'awake' })).toMatchObject({ url: 'u/bear-awake.png' });
    expect(resolveSprite('bear', { ...o, variant: 'awake' })).toMatchObject({ url: 'u/bear-awake.png' });
    expect(resolveSprite('guard', { ...o, guardKind: 'patrol' })).toMatchObject({ url: 'u/robot.png' });
    expect(resolveSprite('guard', { art: { 'guard:awake': 'g/awake.png' }, defaults, palette, kind: 'guard', variant: 'awake' }))
      .toMatchObject({ url: 'g/awake.png' });
  });

  test('avatars: generated art wins, bots keep their personality face, others hash stably over present files', () => {
    expect(AVATAR_ART.length).toBeGreaterThanOrEqual(6);
    const a1 = avatarArtFor({ id: 'p1', avatar: '' }, defaults);
    expect(a1 === 'avatar-cat' || a1 === 'avatar-fox').toBe(true);
    expect(avatarArtFor({ id: 'p1', avatar: '' }, defaults)).toBe(a1);
    expect(avatarArtFor({ id: 'p1', avatar: 'avatar-fox' }, defaults)).toBe('avatar-fox');
    const art = { 'avatar:p1': 'https://cdn/p1.png' };
    expect(resolveSprite('avatar:p1', { art, defaults, palette, kind: 'player' })).toMatchObject({ url: 'https://cdn/p1.png' });
    expect(resolveSprite('avatar:p2', { art: {}, defaults, palette, kind: 'player', avatar: 'https://cdn/self.png' }))
      .toMatchObject({ url: 'https://cdn/self.png' });
    expect(resolveSprite('avatar:p3', { art: {}, defaults: {}, palette, kind: 'player' })).toMatchObject({ type: 'shape', shape: 'blob' });
  });
});

describe('telegraph visual state', () => {
  test('unarmed hazard: translucent, filling warning, arrow along ax/ay; armed: solid, no arrow', () => {
    const props = { armed: false, warnMs: 1000, armAt: 5, ax: 300, ay: 0 };
    const early = telegraphState(props, 4.1);
    const late = telegraphState(props, 4.9);
    expect(early.armed).toBe(false);
    expect(early.progress).toBeCloseTo(0.1, 5);
    expect(late.progress).toBeCloseTo(0.9, 5);
    expect(early.alpha).toBeGreaterThan(0.2);
    expect(early.alpha).toBeLessThan(0.8);
    expect(early.arrow).toEqual({ dx: 1, dy: 0 });
    expect(telegraphState({ ...props, ax: 0, ay: 0 }, 4.5).arrow).toBeNull();
    const armed = telegraphState({ ...props, armed: true }, 6);
    expect(armed).toMatchObject({ armed: true, progress: 1, alpha: 1, arrow: null });
  });

  test('guard visual: awake flag, cone only when vision is on, noise colour ramps', () => {
    const asleep = guardVisual({ awake: false, noise: 0.2, facing: 0, visionOn: false, visionConeDeg: 70, visionRange: 380 });
    expect(asleep.awake).toBe(false);
    expect(asleep.cone).toBeNull();
    const awake = guardVisual({ awake: true, noise: 0.95, facing: Math.PI, visionOn: true, visionConeDeg: 70, visionRange: 380 });
    expect(awake.cone).toEqual({ facing: Math.PI, half: (35 * Math.PI) / 180, range: 380 });
    expect(awake.noiseColor).not.toBe(asleep.noiseColor);
  });

  test('avatar blinks while invulnerable and wobbles while stunned', () => {
    expect(avatarFx({}, 1)).toEqual({ alpha: 1, wobble: 0, stunned: false });
    const inv = [0, 0.05, 0.1, 0.15].map((t) => avatarFx({ invulnUntil: 2 }, 1 + t).alpha);
    expect(Math.min(...inv)).toBeLessThan(1);
    expect(avatarFx({ stunUntil: 2 }, 1.2).stunned).toBe(true);
  });

  test('lerpPos interpolates and snaps on teleports', () => {
    expect(lerpPos({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
    expect(lerpPos({ x: 0, y: 0 }, { x: 900, y: 0 }, 0.5)).toEqual({ x: 900, y: 0 });
  });
});

describe('snapshot interpolation', () => {
  const DT = 1 / 60;
  const snap = (step: number, x: number) => ({ time: step * DT, entities: [{ id: 1, x, y: 0 }] });

  test('frames with no step keep interpolating between the last two distinct sim times', () => {
    const it = new SnapInterp();
    expect(it.push(snap(1, 0))).toBe(true);
    expect(it.push(snap(2, 10))).toBe(true);
    // the host calls snapshot() again without stepping: a new object, same sim time
    const again = snap(2, 10);
    expect(it.push(again)).toBe(false);
    expect(it.pos(again.entities[0]!, 0.5)).toEqual({ x: 5, y: 0 });
    expect(it.push(snap(2, 10))).toBe(false);
    expect(it.pos({ id: 1, x: 10, y: 0 }, 0.25)).toEqual({ x: 2.5, y: 0 });
  });

  test('slow-mo at timeScale 0.3 gives monotonic, smooth positions', () => {
    const it = new SnapInterp();
    const v = 300; // px/s
    let steps = 0, acc = 0;
    const xs: number[] = [];
    it.push(snap(0, 0));
    for (let frame = 0; frame < 240; frame++) {
      acc += DT * 0.3;
      while (acc >= DT - 1e-9) {
        steps++;
        acc -= DT;
      }
      const s = snap(steps, v * steps * DT); // fresh object every frame, as snapshot() does
      it.push(s);
      xs.push(it.pos(s.entities[0]!, acc / DT).x);
    }
    const d = xs.slice(1).map((x, i) => x - xs[i]!).slice(10);
    expect(Math.min(...d)).toBeGreaterThan(0);
    // 1.5 px per frame expected (300 px/s * 0.3 / 60), no stalls or jumps
    expect(Math.min(...d)).toBeGreaterThan(1.2);
    expect(Math.max(...d)).toBeLessThan(1.8);
  });

  test('a new round (time goes backwards) does not lerp from the old round', () => {
    const it = new SnapInterp();
    it.push(snap(100, 0));
    it.push(snap(101, 50));
    it.push(snap(1, 400));
    expect(it.pos({ id: 1, x: 400, y: 0 }, 0)).toMatchObject({ x: 400, y: 0 });
  });
});
