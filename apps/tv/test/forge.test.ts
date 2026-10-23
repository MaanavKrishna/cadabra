import { describe, expect, test } from 'vitest';
import { FALLBACK_SPECS, type Pitch } from '@cadabra/spec';
import { initialState, reduce, type PartyState } from '../src/state/machine';
import { phoneScreen } from '../src/net/screens';
import { pickWinner, shownPct, stepRows, tally } from '../src/forge/forge';

const pal = { bg: '#0a0e27', primary: '#00e5ff', accent: '#ff2bd6', glow: '#b6ff3b', text: '#ffffff' } as const;
const pitch = (id: string): Pitch => ({ id, title: `Game ${id}`, hook: `Hook ${id}`, keyArtPrompt: 'x', palette: pal, blocksSketch: [] });
const PITCHES = [pitch('p1'), pitch('p2'), pitch('p3')];
const spec = FALLBACK_SPECS[0]!;

function seated(): PartyState {
  let s = initialState('ABCD');
  s = reduce(s, { type: 'join', id: 'a', name: 'Asha' });
  s = reduce(s, { type: 'join', id: 'b', name: 'Ravi' });
  return s;
}

describe('forge flow', () => {
  test('storm -> pitching -> voting -> forge with forgeId filtering', () => {
    let s = reduce(seated(), { type: 'storm' });
    expect(s.phase).toBe('storm');
    s = reduce(s, { type: 'ingredient', by: 'a', text: 'laser sharks' });
    expect(s.ingredients).toEqual([{ by: 'a', text: 'laser sharks' }]);
    expect(phoneScreen(s, 'a', true)?.name).toBe('storm');

    // pitches are ignored until the TV is waiting for them
    expect(reduce(s, { type: 'forge', msg: { t: 'forge.pitches', forgeId: 'F1', pitches: PITCHES } }).phase).toBe('storm');
    s = reduce(s, { type: 'phase', phase: 'pitching' });
    expect(phoneScreen(s, 'a', true)?.name).toBe('wait');
    s = reduce(s, { type: 'forge', msg: { t: 'forge.pitches', forgeId: 'F1', pitches: PITCHES } });
    expect(s.phase).toBe('voting');
    expect(s.forge.id).toBe('F1');
    const vote = phoneScreen(s, 'a', true);
    expect(vote?.name).toBe('vote');
    expect(vote?.name === 'vote' && vote.data.options?.length).toBe(3);

    // a stale forge's messages are dropped
    const stale = reduce(s, { type: 'forge', msg: { t: 'forge.progress', forgeId: 'OLD', pitchId: 'p1', step: 'x', pct: 50 } });
    expect(stale.forge.progress).toEqual({});
    // late pitches from another forge do not replace the vote
    expect(reduce(s, { type: 'forge', msg: { t: 'forge.pitches', forgeId: 'F2', pitches: [pitch('q1'), pitch('q2'), pitch('q3')] } }).pitches).toBe(s.pitches);

    s = reduce(s, { type: 'vote', by: 'a', vote: 1 });
    s = reduce(s, { type: 'forge', msg: { t: 'forge.progress', forgeId: 'F1', pitchId: 'p2', step: 'Picking blocks', pct: 30 } });
    s = reduce(s, { type: 'forge', msg: { t: 'forge.progress', forgeId: 'F1', pitchId: 'p2', step: 'Picking blocks', pct: 20 } });
    expect(s.forge.progress.p2).toEqual({ step: 'Picking blocks', pct: 30, steps: ['Picking blocks'] });
    s = reduce(s, { type: 'winner', pitchId: 'p2' });
    expect(s.phase).toBe('forge');
    const w = phoneScreen(s, 'b', true);
    expect(w?.name === 'wait' && w.data.progress).toBe(30);

    s = reduce(s, { type: 'forge', msg: { t: 'forge.ready', forgeId: 'F1', pitchId: 'p2', spec } });
    expect(s.forge.ready.p2?.spec.id).toBe(spec.id);
    s = reduce(s, { type: 'forge', msg: { t: 'forge.art', forgeId: 'F1', pitchId: 'p2', key: 'keyArt', url: 'https://x/a.png' } });
    expect(s.forge.art.p2).toEqual({ keyArt: 'https://x/a.png' });
    // art that lands mid-game reaches the live game
    s = reduce(s, { type: 'start', spec, art: s.forge.art.p2 });
    s = reduce(s, { type: 'forge', msg: { t: 'forge.art', forgeId: 'F1', pitchId: 'p2', key: 'hero', url: 'https://x/h.png' } });
    expect(s.art).toEqual({ keyArt: 'https://x/a.png', hero: 'https://x/h.png' });
  });

  test('vote tie broken by TV select', () => {
    const votes = { a: 0, b: 2 };
    expect(tally(votes, 3)).toEqual([1, 0, 1]);
    expect(pickWinner(votes, 3, 2)).toBe(2);
    expect(pickWinner(votes, 3, 1, 0)).toBe(0); // TV vote not among the tied: focused tile
    expect(pickWinner(votes, 3)).toBe(0);
    expect(pickWinner({ a: 1, b: 1, c: 2 }, 3, 2)).toBe(1); // a clear majority beats the TV
    expect(pickWinner({}, 3, 2)).toBe(2); // nobody voted: the TV decides

    let s = reduce(seated(), { type: 'storm' });
    s = reduce(s, { type: 'phase', phase: 'pitching' });
    s = reduce(s, { type: 'forge', msg: { t: 'forge.pitches', forgeId: 'F', pitches: PITCHES } });
    s = reduce(s, { type: 'tvVote', vote: 2 });
    expect(s.forge.tvVote).toBe(2);
    expect(reduce(s, { type: 'tvVote', vote: 9 }).forge.tvVote).toBe(2);
  });

  test('forge screen state: stages tick off by pct, 100% only when ready', () => {
    expect(stepRows(undefined, false).map((r) => r.state)).toEqual(['active', 'todo', 'todo', 'todo']);
    expect(stepRows({ step: 'x', pct: 40, steps: [] }, false).map((r) => r.state)).toEqual(['done', 'active', 'todo', 'todo']);
    expect(stepRows({ step: 'Picking blocks', pct: 15, steps: [] }, false).map((r) => r.state)).toEqual(['done', 'active', 'todo', 'todo']);
    expect(stepRows({ step: 'Game ready', pct: 100, steps: [] }, false).map((r) => r.state)).toEqual(['done', 'done', 'active', 'todo']);
    expect(stepRows({ step: 'x', pct: 80, steps: [] }, false).map((r) => r.state)).toEqual(['done', 'done', 'active', 'todo']);
    expect(stepRows({ step: 'x', pct: 80, steps: [] }, true).every((r) => r.state === 'done')).toBe(true);
    expect(shownPct({ step: 'x', pct: 100, steps: [] }, false)).toBe(96);
    expect(shownPct(undefined, true)).toBe(100);
  });

  test('a new storm forgets the last forge', () => {
    let s = reduce(seated(), { type: 'storm' });
    s = reduce(s, { type: 'phase', phase: 'pitching' });
    s = reduce(s, { type: 'forge', msg: { t: 'forge.pitches', forgeId: 'F', pitches: PITCHES } });
    s = reduce(s, { type: 'storm' });
    expect(s.forge).toEqual({ progress: {}, ready: {}, art: {} });
    expect(s.pitches).toEqual([]);
  });
});
