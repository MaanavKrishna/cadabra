import { describe, expect, test, vi } from 'vitest';
import type { Theme } from '@cadabra/spec';

// logic only: nothing here may need a GPU
vi.mock('pixi.js', () => ({}));

import { FxBudget, JuiceState } from '../src/juice';
import { themeVars } from '../src/theme';
import { resolveSprite } from '../src/sprites';
import { sfx } from '../src/sfx';

const theme: Theme = {
  palette: { bg: '#2b1a12', primary: '#ff9f1c', accent: '#e63946', glow: '#ffd166', text: '#fff6e5' },
  artStyle: 'storybook',
  keyArtPrompt: 'bear',
  sprites: {},
  sfxSet: 'cartoon',
};

describe('juice (brief)', () => {
  test('fx budget caps particles at 250 and halves cap when fps feedback < 45 for 2 s', () => {
    const b = new FxBudget(250);
    expect(b.request(300)).toBe(250);
    expect(b.request(10)).toBe(0);
    b.release(250);
    // 1.5 s of slow frames: not yet
    for (let i = 0; i < 45; i++) b.fpsFeedback(30);
    expect(b.cap).toBe(250);
    // a good frame resets the slow streak
    b.fpsFeedback(60);
    for (let i = 0; i < 45; i++) b.fpsFeedback(30);
    expect(b.cap).toBe(250);
    // 2 s straight below 45 fps halves the cap
    for (let i = 0; i < 15; i++) b.fpsFeedback(30);
    expect(b.cap).toBe(125);
    expect(b.request(300)).toBe(125);
  });

  test('themeVars maps palette to css vars', () => {
    expect(themeVars(theme)).toEqual({
      '--c-bg': '#2b1a12',
      '--c-primary': '#ff9f1c',
      '--c-accent': '#e63946',
      '--c-glow': '#ffd166',
      '--c-text': '#fff6e5',
    });
  });

  test('missing sprite art falls back to shape descriptor', () => {
    const src = resolveSprite('banana', { art: {}, defaults: {}, palette: theme.palette, kind: 'item' });
    expect(src.type).toBe('shape');
    if (src.type === 'shape') {
      expect(src.shape).toBe('orb');
      expect(src.color).toBe(theme.palette.glow);
    }
    // a default whose file is missing from the pack also falls back
    const hz = resolveSprite('hazard', { art: {}, defaults: {}, palette: theme.palette, kind: 'hazard' });
    expect(hz).toMatchObject({ type: 'shape', shape: 'spiky', color: theme.palette.accent });
  });
});

describe('juice state', () => {
  test('shake decays, flash fades, slow-mo eases back to 1', () => {
    const j = new JuiceState();
    j.apply({ kind: 'shake', strength: 0.6 });
    j.apply({ kind: 'flash', color: '#ff3b3b' });
    j.apply({ kind: 'slowmo', ms: 500 });
    expect(j.timeScale).toBeLessThan(1);
    const o1 = j.shakeOffset(0);
    expect(Math.hypot(o1.x, o1.y)).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) j.tick(1 / 60);
    expect(j.trauma).toBe(0);
    expect(j.flashAlpha).toBe(0);
    expect(j.timeScale).toBe(1);
  });

  test('sfx never throws without AudioContext', () => {
    for (const n of ['score', 'hit', 'whoosh', 'win', 'lose', 'tick', 'wake', 'pass', 'splash', 'coin', 'nope']) {
      expect(() => sfx(n)).not.toThrow();
    }
  });
});
