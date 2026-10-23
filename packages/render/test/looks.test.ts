import { describe, expect, test } from 'vitest';
import type { Theme } from '@cadabra/spec';
import { LOOKS, LOOK_IDS, lookOf, soundOf } from '../src/looks';
import { MUSIC_STYLES, renderLoop } from '../src/music';
import { neonKey, PROP_KEYS } from '../src/neon';

const theme = (o: Partial<Theme> & Record<string, unknown> = {}): Theme => ({
  palette: { bg: '#000000', primary: '#ffffff', accent: '#ffffff', glow: '#ffffff', text: '#ffffff' },
  artStyle: 'neon arcade', keyArtPrompt: 'x', sprites: {}, sfxSet: 'neon', ...o,
}) as Theme;

describe('looks', () => {
  test('explicit look ids win, in any of the accepted fields', () => {
    expect(lookOf(theme({ look: 'toybox' }))).toBe('toybox');
    expect(lookOf(theme({ id: 'cosmos' }))).toBe('cosmos');
    expect(lookOf(theme({ sfxSet: 'retro' as Theme['sfxSet'] }))).toBe('retro');
  });
  test('art style words pick a look, else neon', () => {
    expect(lookOf(theme({ artStyle: 'glossy plastic toy' }))).toBe('toybox');
    expect(lookOf(theme({ artStyle: 'deep space nebula' }))).toBe('cosmos');
    expect(lookOf(theme({ artStyle: '8-bit pixel arcade' }))).toBe('retro');
    expect(lookOf(theme())).toBe('neon');
    expect(lookOf(undefined)).toBe('neon');
  });
  test('every look has 4+ distinct player colours, two team colours and its own music', () => {
    for (const id of LOOK_IDS) {
      const L = LOOKS[id];
      expect(new Set(L.players.slice(0, 4)).size).toBe(4);
      expect(L.teams[0]).not.toBe(L.teams[1]);
      expect(MUSIC_STYLES[L.sound]).toBeDefined();
    }
    expect(soundOf(theme({ look: 'retro' }))).toBe('retro');
    expect(soundOf(theme({ sfxSet: 'spooky' }))).toBe('spooky');
  });
  test('look music loops are audible and finite', () => {
    for (const id of ['toybox', 'cosmos', 'retro']) {
      const { base, final } = renderLoop(MUSIC_STYLES[id]!, 8000);
      let peak = 0, finite = true;
      for (const a of [base, final]) for (const v of a) {
        if (!Number.isFinite(v)) finite = false;
        peak = Math.max(peak, Math.abs(v));
      }
      expect(finite).toBe(true);
      expect(peak).toBeGreaterThan(0.05);
    }
  });
  test('physics prop keys resolve from sprites and kinds', () => {
    for (const k of PROP_KEYS) expect(neonKey(k, 'prop')).toBe(k);
    expect(neonKey('tnt', 'hazard')).toBe('barrel');
    expect(neonKey('', 'crate')).toBe('crate');
    expect(neonKey('soccer-ball', 'item')).toBe('ball');
  });
});
