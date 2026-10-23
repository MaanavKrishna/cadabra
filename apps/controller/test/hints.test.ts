import { describe, expect, test } from 'vitest';
import { FALLBACK_SPECS } from '@cadabra/spec';
import { hintsFor, relabel } from '../src/hints';

describe('contextual control hints', () => {
  test('the built-in games explain every control', () => {
    const byId = (id: string) => FALLBACK_SPECS.find((s) => s.id === id)!;
    for (const spec of FALLBACK_SPECS) {
      const h = hintsFor(spec.controller, spec.title);
      expect(h).toHaveLength(spec.controller.length);
      for (const x of h) expect(x.sub.length).toBeGreaterThan(3);
    }
    const ring = byId('fallback-ring-out');
    expect(hintsFor(ring.controller, ring.title)).toMatchObject([{ label: 'MOVE', sub: 'stay on the ring' }, { label: 'DASH', icon: 'dash', sub: 'tap to shove' }]);
    const paint = byId('fallback-paint-wars');
    expect(hintsFor(paint.controller, paint.title)[1]).toMatchObject({ label: 'DASH', sub: 'tap to splash' });
    const dash = byId('fallback-neon-dash');
    expect(hintsFor(dash.controller, dash.title).map((x) => x.label)).toEqual(['RUN', 'JUMP']);
    expect(hintsFor(dash.controller, dash.title)[0]!.sub).toMatch(/mash/i);
  });

  test('unknown buttons keep their own label; relabel only touches buttons', () => {
    const w = [{ kind: 'button', id: 'zap', label: 'Zap' } as const, { kind: 'joystick', id: 'move' } as const];
    const h = hintsFor(w);
    expect(h[0]).toMatchObject({ label: 'ZAP', icon: 'tap' });
    const r = relabel(w, h);
    expect(r[0]).toMatchObject({ label: 'ZAP' });
    expect(r[1]).toEqual(w[1]);
  });
});
