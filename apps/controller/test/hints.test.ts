import { describe, expect, test } from 'vitest';
import { FALLBACK_SPECS } from '@cadabra/spec';
import { hintsFor, relabel } from '../src/hints';

describe('contextual control hints', () => {
  test('the built-in games explain every control', () => {
    const [heist, penguins, tug] = FALLBACK_SPECS;
    const h = hintsFor(heist!.controller, heist!.title);
    expect(h.map((x) => x.label)).toEqual(['MOVE', 'TIPTOE']);
    expect(h[1]!.sub).toMatch(/quiet/);
    expect(hintsFor(penguins!.controller, penguins!.title).map((x) => x.icon)).toContain('dash');
    expect(hintsFor(tug!.controller, tug!.title)[0]).toMatchObject({ label: 'PULL', sub: 'tap on the beat!' });
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
