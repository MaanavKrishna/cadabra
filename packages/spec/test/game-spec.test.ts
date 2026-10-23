import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SETTINGS, GameSpecSchema, PeerMsgSchema, PitchSchema, RoomSettingsSchema, parseSpec,
} from '../src/index';
import heist from './fixtures/heist.json';

const clone = () => structuredClone(heist) as Record<string, any>;

describe('parseSpec', () => {
  test('accepts a minimal valid spec', () => {
    const r = parseSpec(heist);
    expect(r.ok).toBe(true);
    expect(GameSpecSchema.safeParse(heist).success).toBe(true);
  });

  test('rejects durationSec 20 and 200 (30..45 is quick-fire party mode)', () => {
    for (const d of [20, 200]) {
      const s = clone();
      s.durationSec = d;
      const r = parseSpec(s);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => e.includes('durationSec'))).toBe(true);
    }
  });

  test('rejects unknown widget kind', () => {
    const s = clone();
    s.controller.push({ kind: 'laser', id: 'x' });
    expect(parseSpec(s).ok).toBe(false);
  });

  test('rejects timeline atSec beyond durationSec', () => {
    const s = clone();
    s.timeline[1].atSec = 95;
    const r = parseSpec(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/timeline.*atSec/);
  });

  test('requires >=1 block and >=1 controller widget', () => {
    const a = clone();
    a.blocks = [];
    const b = clone();
    b.controller = [];
    const ra = parseSpec(a);
    const rb = parseSpec(b);
    expect(ra.ok).toBe(false);
    expect(rb.ok).toBe(false);
    if (!ra.ok) expect(ra.errors.join()).toContain('blocks');
    if (!rb.ok) expect(rb.errors.join()).toContain('controller');
  });

  test('rejects bad palette hex and over-long title', () => {
    const a = clone();
    a.theme.palette.bg = 'red';
    const b = clone();
    b.title = 'x'.repeat(41);
    expect(parseSpec(a).ok).toBe(false);
    expect(parseSpec(b).ok).toBe(false);
  });

  test('error format is "path: message"', () => {
    const s = clone();
    s.durationSec = 20;
    const r = parseSpec(s);
    if (r.ok) throw new Error('expected failure');
    expect(r.errors[0]).toMatch(/^durationSec: /);
  });
});

describe('settings, pitch, protocol', () => {
  test('DEFAULT_SETTINGS validates', () => {
    expect(RoomSettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
    expect(RoomSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, roundSec: 30 }).success).toBe(false);
    expect(RoomSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, rounds: 11 }).success).toBe(false);
  });

  test('PitchSchema accepts a pitch', () => {
    const p = {
      id: 'p1', title: 'Ladoo Heist', hook: 'Sneak.', keyArtPrompt: 'bear',
      palette: heist.theme.palette, blocksSketch: ['sneak', 'collect'],
    };
    expect(PitchSchema.safeParse(p).success).toBe(true);
  });

  test('PeerMsg accepts input/screen/ping/pong and rejects unknown', () => {
    expect(PeerMsgSchema.safeParse({ t: 'input', frame: { t: 1, axes: { x: 0, y: 1 } } }).success).toBe(true);
    expect(PeerMsgSchema.safeParse({ t: 'screen', name: 'play' }).success).toBe(true);
    expect(PeerMsgSchema.safeParse({ t: 'ping', id: 1 }).success).toBe(true);
    expect(PeerMsgSchema.safeParse({ t: 'pong', id: 1 }).success).toBe(true);
    expect(PeerMsgSchema.safeParse({ t: 'screen', name: 'nope' }).success).toBe(false);
    expect(PeerMsgSchema.safeParse({ t: 'zzz' }).success).toBe(false);
  });
});
