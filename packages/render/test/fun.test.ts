import { describe, expect, test } from 'vitest';
import { popupText, popupTone, itemNoun } from '../src/popups';
import { FxDirector, comboForEvent, comboForPreset } from '../src/director';
import { MUSIC_STYLES, loopSamples, renderLoop, startMusic, stopMusic, setMusicIntensity, duckMusic, setMusicVolume, prewarmMusic, musicPlaying } from '../src/music';
import { CameraRig, SHOT_ZOOM, ZOOM_MAX } from '../src/camera';
import { arenaRect, sceneFor } from '../src/scenery';
import { fitName } from '../src/hud';

describe('self-explaining popups', () => {
  test('engine reasons, codes and the final-10 multiplier', () => {
    expect(popupText(3, 'Banked!')).toBe('+3 Banked!');
    expect(popupText(-2, 'Woke the bear!')).toBe('−2 Woke the bear!');
    expect(popupText(1, '+1 Ladoo')).toBe('+1 Ladoo');
    expect(popupText(1, 'collect.item', 'Ladoo')).toBe('+1 Ladoo');
    expect(popupText(2, 'collect.banked')).toBe('+2 Banked!');
    expect(popupText(4, 'Banked!', '', 2)).toBe('+4 Banked! ×2');
    expect(popupText(5, 'mystery.code')).toBe('+5');
    expect(popupText(-1, undefined)).toBe('−1');
    expect(itemNoun('golden-fish')).toBe('Fish');
    expect(itemNoun('ladoo')).toBe('Ladoo');
    expect(popupTone(-2, 'Lava!')).toBe('loss');
    expect(popupTone(3, 'Banked!')).toBe('big');
    expect(popupTone(1, 'Fish')).toBe('gain');
  });
});

describe('juice rules: fx director', () => {
  test('maps presets and moments to combos; confetti is never ambient', () => {
    expect(comboForPreset('confetti')).toBe('bank');
    expect(comboForPreset('sparkle')).toBe('pickup');
    expect(comboForPreset('nope')).toBeNull();
    expect(comboForEvent('heist.bank', 'bank')).toBe('bank');
    expect(comboForEvent('play.chase.start', 'chase.start')).toBe('chase');
    expect(comboForEvent('penguin.knockout', 'knockout')).toBe('blast');
    expect(comboForEvent('ringout.ringout', 'ringout')).toBe('blast');
    expect(comboForEvent('overload.detonate', 'detonate')).toBe('blast');
    expect(comboForEvent('score')).toBeNull();
  });

  test('dedupes the same moment, rate-limits kinds and caps a burst window', () => {
    const d = new FxDirector({ maxPerWindow: 4, windowSec: 0.6 });
    expect(d.allow('bank', 100, 100, 0)).toBe(true);
    expect(d.allow('bank', 120, 100, 0.05)).toBe(false); // same moment reported twice
    expect(d.allow('dash', 500, 500, 0.1)).toBe(true);
    expect(d.allow('dash', 900, 100, 0.2)).toBe(false); // dash gap
    expect(d.allow('pickup', 900, 100, 0.2)).toBe(true);
    expect(d.allow('pickup', 300, 300, 0.3)).toBe(true);
    // window full (4): low priority refused, high priority still gets through
    expect(d.allow('dash', 700, 700, 0.45)).toBe(false);
    expect(d.allow('golden', 50, 50, 0.4)).toBe(true);
    // later it frees up
    expect(d.allow('pickup', 700, 700, 1.5)).toBe(true);
  });
});

describe('procedural music', () => {
  test('a 4-bar loop per style, deterministic, finite and loud enough', () => {
    for (const [name, st] of Object.entries(MUSIC_STYLES)) {
      const a = renderLoop(st, 4000), b = renderLoop(st, 4000);
      expect(a.base.length, name).toBe(loopSamples(st, 4000));
      expect(a.final.length).toBe(a.base.length);
      let peak = 0;
      for (let i = 0; i < a.base.length; i++) {
        expect(Number.isFinite(a.base[i]!)).toBe(true);
        peak = Math.max(peak, Math.abs(a.base[i]!));
      }
      expect(peak).toBeGreaterThan(0.2);
      expect(peak).toBeLessThanOrEqual(1);
      expect(a.base.slice(0, 500)).toEqual(b.base.slice(0, 500));
    }
  });

  test('every entry point is a no-op without WebAudio', () => {
    expect(() => {
      prewarmMusic('cartoon');
      startMusic('cartoon');
      setMusicIntensity(true);
      duckMusic(true);
      setMusicVolume(0.3);
      stopMusic();
    }).not.toThrow();
    expect(musicPlaying()).toBe(false);
  });
});

describe('readability: camera and arena', () => {
  test('framing zooms softly on clustered players, not at all when spread out', () => {
    const c = new CameraRig(1920, 1080);
    for (let i = 0; i < 300; i++) {
      c.frame(100, 100, 1800, 1000);
      c.tick(1 / 60);
    }
    expect(c.zoom).toBeCloseTo(1, 2);
    for (let i = 0; i < 300; i++) {
      c.frame(900, 500, 1000, 560);
      c.tick(1 / 60);
    }
    expect(c.zoom).toBeGreaterThan(1.03);
    expect(c.zoom).toBeLessThanOrEqual(ZOOM_MAX);
  });

  test('the winner close-up goes further, then hands back', () => {
    const c = new CameraRig(1920, 1080);
    c.closeUp(600, 400);
    for (let i = 0; i < 400; i++) c.tick(1 / 60);
    expect(c.zoom).toBeGreaterThan(1.3);
    expect(c.zoom).toBeLessThanOrEqual(SHOT_ZOOM);
    c.endShot();
    for (let i = 0; i < 600; i++) c.tick(1 / 60);
    expect(c.zoom).toBeCloseTo(1, 2);
  });

  test('arena sits inside title-safe margins; scenes follow the theme', () => {
    const r = arenaRect(1920, 1080, 1280, 720);
    expect(r.x).toBeGreaterThanOrEqual(96);
    expect(r.y).toBeGreaterThanOrEqual(54);
    expect(r.x * 2 + r.w).toBeCloseTo(1920, 5);
    const t = (words: string) => ({ sprites: { a: words }, keyArtPrompt: '', artStyle: '' });
    expect(sceneFor(t('golden ladoo sweet'))).toBe('kitchen');
    expect(sceneFor(t('round penguin, lava'))).toBe('lava');
    expect(sceneFor(t('anything'), 'tug')).toBe('field');
    expect(sceneFor(t('robot'))).toBe('generic');
  });

  test('chip names are truncated without measuring text', () => {
    expect(fitName('Baron Von Bounce', 120, 11)).toBe('Baron Von…');
    expect(fitName('MK', 120, 11)).toBe('MK');
  });
});
