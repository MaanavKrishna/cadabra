import { describe, expect, test } from 'vitest';
import { FALLBACK_SPECS } from '@cadabra/spec';
import { COUNT_MS, GO_MS, INTRO_MS, LEAD_GAP_SEC, LeadWatch, TIME_MS, WINNER_MS, countdownAt, flowAt, playAt, type FlowClock } from '../src/play/flow';
import { introFor } from '../src/play/intro';

describe('match flow', () => {
  test('intro -> countdown -> play -> final -> time -> winner -> done', () => {
    const c: FlowClock = { mountAt: 1000 };
    // still loading: intro however long it takes
    expect(flowAt(c, 9000, 60).phase).toBe('intro');
    expect(flowAt(c, 9000, 60).running).toBe(false);
    c.loadedAt = 1500; // fast load: intro still lasts INTRO_MS
    expect(countdownAt(c)).toBe(1000 + INTRO_MS);
    expect(flowAt(c, 1000 + INTRO_MS - 1, 60).phase).toBe('intro');
    const cd = countdownAt(c)!;
    expect(flowAt(c, cd, 60)).toMatchObject({ phase: 'countdown', count: 3, running: false });
    expect(flowAt(c, cd + 1000, 60).count).toBe(2);
    expect(flowAt(c, cd + 2999, 60).count).toBe(1);
    const go = playAt(c)!;
    expect(go).toBe(cd + COUNT_MS);
    expect(flowAt(c, go, 60)).toMatchObject({ phase: 'play', count: 'GO', running: true });
    expect(flowAt(c, go + GO_MS + 1, 60).count).toBeUndefined();
    expect(flowAt(c, go + 50_000, 10).phase).toBe('final');
    expect(flowAt(c, go + 50_000, 10.01).phase).toBe('play');
    c.overAt = go + 60_000;
    expect(flowAt(c, c.overAt + 10, 0)).toMatchObject({ phase: 'time', running: false });
    expect(flowAt(c, c.overAt + TIME_MS, 0).phase).toBe('winner');
    expect(flowAt(c, c.overAt + TIME_MS + WINNER_MS, 0).phase).toBe('done');
  });

  test('a slow load holds the intro until the art is in', () => {
    const c: FlowClock = { mountAt: 0, loadedAt: 7000 };
    expect(countdownAt(c)).toBe(7000);
    expect(flowAt(c, 6999, 60).phase).toBe('intro');
    expect(flowAt(c, 7000, 60).phase).toBe('countdown');
  });

  test('lead fallback: unique leader, throttled to one per LEAD_GAP_SEC', () => {
    const w = new LeadWatch();
    expect(w.fromScores([{ id: 'a', score: 0 }, { id: 'b', score: 0 }], 1)).toBeUndefined();
    expect(w.fromScores([{ id: 'a', score: 2 }, { id: 'b', score: 1 }], 2)).toBe('a');
    expect(w.fromScores([{ id: 'a', score: 2 }, { id: 'b', score: 3 }], 3)).toBeUndefined(); // too soon
    expect(w.fromScores([{ id: 'a', score: 2 }, { id: 'b', score: 3 }], 2 + LEAD_GAP_SEC)).toBe('b');
    expect(w.fromScores([{ id: 'a', score: 3 }, { id: 'b', score: 3 }], 30)).toBeUndefined(); // tie
    // once the engine sends lead.change events, the fallback stays quiet
    expect(w.fromEvent('a', undefined)).toEqual({ player: 'a' });
    expect(w.fromScores([{ id: 'a', score: 9 }, { id: 'b', score: 3 }], 60)).toBeUndefined();
    expect(w.fromEvent('x', 1)).toEqual({ team: 1 });
  });
});

describe('intro card', () => {
  test('every fallback has goal steps with icons and its phone controls', () => {
    for (const spec of FALLBACK_SPECS) {
      const i = introFor(spec);
      expect(i.steps.length).toBeGreaterThanOrEqual(2);
      expect(i.steps.every((s) => s.icon)).toBe(true);
      expect(i.controls.length).toBe(spec.controller.length);
    }
    const heist = introFor(FALLBACK_SPECS[0]!);
    expect(heist.controls.map((c) => c.kind)).toEqual(['stick', 'hold']);
    expect(heist.controls[1]!.label + (heist.controls[1]!.hint ?? '')).toMatch(/quiet/i);
  });

  test('generated games get steps from their blocks', () => {
    const base = FALLBACK_SPECS[0]!;
    const i = introFor({ ...base, id: 'gen-1', blocks: [{ block: 'collect', params: { itemSprite: 'gem', carryToGoal: true } }, { block: 'dodge', params: { hazardSprite: 'fireball' } }] });
    expect(i.steps.map((s) => s.text)).toEqual(['Grab gems', 'Bank them at your base', 'Dodge the fireball']);
  });
});

import { momentCallout } from '../src/play/flow';
describe('headline moments', () => {
  const name = (id?: string) => (id ?? 'someone').toUpperCase();
  test('big moments get a banner, small ones none', () => {
    expect(momentCallout({ type: 'heist.chase.start', player: 'ann', data: { moment: 'chase.start' } }, name, 'LADOO')?.title).toBe('RUN, ANN!');
    expect(momentCallout({ type: 'play.golden', data: { moment: 'golden', phase: 'spawn' } }, name, 'LADOO')?.title).toBe('GOLDEN LADOO!');
    expect(momentCallout({ type: 'heist.golden', data: { moment: 'golden', phase: 'bank' } }, name, 'LADOO')).toBeUndefined();
    expect(momentCallout({ type: 'penguin.knockout', player: 'a', data: { moment: 'knockout', victim: 'b' } }, name, 'FISH')?.sub).toBe('A shoved B in');
    expect(momentCallout({ type: 'tug.splash', data: { moment: 'splash', winners: 1 } }, name, '')?.sub).toBe('Blue team pulls them in!');
    expect(momentCallout({ type: 'heist.bank', player: 'a', data: { moment: 'bank' } }, name, 'LADOO')).toBeUndefined();
    expect(momentCallout({ type: 'tug.surge', data: { moment: 'surge' } }, name, '')).toBeUndefined();
  });
});
