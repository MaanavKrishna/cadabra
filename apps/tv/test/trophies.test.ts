import { describe, expect, it } from 'vitest';
import { MAX_PER_ROUND, TrophyWatch } from '../src/play/trophies';

const name = (id?: string) => (id === 'a' ? 'Asha' : 'Ravi');

describe('TrophyWatch', () => {
  it('unlocks a trophy once per round, with the player name', () => {
    const w = new TrophyWatch();
    const t = w.next({ type: 'ring.ringout', player: 'a', data: { moment: 'ringout' } }, 3, name);
    expect(t).toMatchObject({ id: 'ringout', name: 'First Ring Out', who: 'Asha', tier: 'bronze' });
    expect(w.next({ type: 'ring.ringout', player: 'b', data: { moment: 'ringout' } }, 20, name)).toBeUndefined();
  });

  it('ignores ordinary events and spaces trophies apart', () => {
    const w = new TrophyWatch();
    expect(w.next({ type: 'score', player: 'a', data: { delta: 1 } }, 1, name)).toBeUndefined();
    expect(w.next({ type: 'rush.steal', player: 'a', data: { moment: 'steal' } }, 2, name)?.id).toBe('steal');
    expect(w.next({ type: 'race.finish', player: 'b' }, 4, name)).toBeUndefined(); // too soon
    expect(w.next({ type: 'race.finish', player: 'b' }, 8, name)?.tier).toBe('gold');
  });

  it('only a clutch pass counts, and the golden grab (not the spawn)', () => {
    const w = new TrophyWatch();
    expect(w.next({ type: 'x.core.pass', data: { moment: 'core.pass', clutch: false } }, 1, name)).toBeUndefined();
    expect(w.next({ type: 'x.golden', data: { moment: 'golden', phase: 'spawn' } }, 1, name)).toBeUndefined();
    expect(w.next({ type: 'x.golden', player: 'b', data: { moment: 'golden', phase: 'grab' } }, 1, name)?.name).toBe('Mega Core');
  });

  it(`caps a round at ${MAX_PER_ROUND}`, () => {
    const w = new TrophyWatch();
    const evs = [
      { type: 'a', data: { moment: 'ringout' } }, { type: 'b', data: { moment: 'overload' } },
      { type: 'c', data: { moment: 'steal' } }, { type: 'd', data: { moment: 'knockout' } },
    ];
    const got = evs.map((e, i) => w.next(e, i * 10, name)).filter(Boolean);
    expect(got).toHaveLength(MAX_PER_ROUND);
  });
});
