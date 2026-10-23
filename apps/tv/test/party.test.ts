import { describe, expect, test } from 'vitest';
import { PARTY_ROUNDS, champions, finishRound, isOver, newParty, nextRound, roundPoints, standings } from '../src/play/party';

const GAMES = ['ring', 'overload', 'paint', 'core', 'dash'];

describe('party mode', () => {
  test('playlist: 4 distinct short rounds from the built-ins, deterministic per seed', () => {
    const a = newParty(GAMES, 7);
    expect(a.rounds).toHaveLength(PARTY_ROUNDS);
    expect(new Set(a.rounds.map((r) => r.gameId)).size).toBe(PARTY_ROUNDS);
    for (const r of a.rounds) {
      expect(GAMES).toContain(r.gameId);
      expect(r.durationSec).toBeGreaterThanOrEqual(35);
      expect(r.durationSec).toBeLessThanOrEqual(45);
    }
    expect(newParty(GAMES, 7)).toEqual(a);
  });

  test('fewer games than rounds repeats, never back to back', () => {
    const r = newParty(['a', 'b'], 3).rounds.map((x) => x.gameId);
    expect(r).toHaveLength(4);
    for (let i = 1; i < r.length; i++) expect(r[i]).not.toBe(r[i - 1]);
  });

  test('free-for-all points by place, ties share the better place', () => {
    expect(roundPoints([{ id: 'a', score: 9 }, { id: 'b', score: 5 }, { id: 'c', score: 5 }, { id: 'd', score: 0 }]))
      .toEqual({ a: 4, b: 3, c: 3, d: 1 });
  });

  test('team games give every member the team result', () => {
    const r = [{ id: 'a', score: 3, team: 0 }, { id: 'b', score: 1, team: 0 }, { id: 'c', score: 9, team: 1 }, { id: 'd', score: 0, team: 1 }];
    expect(roundPoints(r, 1)).toEqual({ a: 1, b: 1, c: 3, d: 3 });
    expect(roundPoints(r)).toEqual({ a: 2, b: 2, c: 2, d: 2 });
  });

  test('points carry across rounds; standings show climbs; champion at the end', () => {
    const ids = ['a', 'b', 'c'];
    let run = newParty(GAMES, 1, 2);
    run = finishRound(run, [{ id: 'a', score: 5 }, { id: 'b', score: 3 }, { id: 'c', score: 1 }]);
    expect(isOver(run)).toBe(false);
    expect(standings(run, ids).map((r) => [r.id, r.points])).toEqual([['a', 3], ['b', 2], ['c', 1]]);
    run = nextRound(run);
    expect(run.index).toBe(1);
    run = finishRound(run, [{ id: 'c', score: 9 }, { id: 'b', score: 4 }, { id: 'a', score: 0 }]);
    expect(isOver(run)).toBe(true);
    const s = standings(run, ids);
    // a 3+1=4, b 2+2=4, c 1+3=4: a three-way tie
    expect(s.every((r) => r.points === 4 && r.rank === 1)).toBe(true);
    expect(s.find((r) => r.id === 'c')!.prevRank).toBe(3);
    expect(s.find((r) => r.id === 'c')!.gained).toBe(3);
    expect(champions(run, ids)).toEqual(['a', 'b', 'c']);
  });

  test('players who skipped a round still appear with 0', () => {
    let run = newParty(GAMES, 2, 1);
    run = finishRound(run, [{ id: 'a', score: 1 }]);
    expect(standings(run, ['a', 'late']).map((r) => r.id)).toEqual(['a', 'late']);
    expect(champions(run, ['a', 'late'])).toEqual(['a']);
  });
});
