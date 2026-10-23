import { describe, expect, test } from 'vitest';
import { PHYSICS_DEFAULTS, THEME_LOOKS, parseSpec, resolvePhysics } from '../src/index';
import heist from './fixtures/heist.json';

const clone = () => structuredClone(heist) as Record<string, any>;

describe('world physics + theme look', () => {
  test('accepts world.physics, props and every look', () => {
    for (const look of THEME_LOOKS) {
      const s = clone();
      s.theme.look = look;
      s.theme.sfxSet = look;
      s.world = { physics: { restitution: 0.9, gravityY: 300 }, props: [{ kind: 'ball', count: 1, layout: 'center' }] };
      expect(parseSpec(s).ok).toBe(true);
    }
  });

  test('rejects bad physics values, unknown props and > 40 props', () => {
    const a = clone();
    a.world = { physics: { restitution: 3 } };
    expect(parseSpec(a).ok).toBe(false);
    const b = clone();
    b.world = { props: [{ kind: 'piano', count: 1 }] };
    expect(parseSpec(b).ok).toBe(false);
    const c = clone();
    c.world = { props: [{ kind: 'crate', count: 12 }, { kind: 'crate', count: 12 }, { kind: 'ball', count: 12 }, { kind: 'barrel', count: 12 }] };
    const r = parseSpec(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/at most 40 props/);
  });

  test('resolvePhysics fills defaults; off without world, on with props', () => {
    expect(resolvePhysics({})).toBeUndefined();
    expect(resolvePhysics({ world: { physics: { enabled: false } } })).toBeUndefined();
    expect(resolvePhysics({ world: { physics: { knockback: 2 } } })).toEqual({ ...PHYSICS_DEFAULTS, knockback: 2 });
    expect(resolvePhysics({ world: { props: [{ kind: 'crate', count: 2 }] } })?.restitution).toBe(PHYSICS_DEFAULTS.restitution);
  });
});
