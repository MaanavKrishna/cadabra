import { describe, expect, test } from 'vitest';
import { FALLBACK_SPECS } from '@cadabra/spec';
import { initialState, reduce, humans, type PartyState } from '../src/state/machine';

const join = (s: PartyState, id: string, name = id) => reduce(s, { type: 'join', id, name });

describe('party state machine', () => {
  test('late join becomes spectator', () => {
    let s = initialState('ABCD');
    s = join(s, 'p1');
    s = reduce(s, { type: 'start', spec: FALLBACK_SPECS[0]! });
    expect(s.phase).toBe('play');
    s = join(s, 'late');
    expect(s.spectators).toEqual(['late']);
    expect(s.players.map((p) => p.id)).not.toContain('late');
    // the same during forge and tutorial
    for (const phase of ['forge', 'tutorial'] as const) {
      let t = reduce(initialState('ABCD'), { type: 'phase', phase });
      t = join(t, 'x');
      expect(t.spectators).toEqual(['x']);
      expect(t.players).toHaveLength(0);
    }
    // a reconnecting player keeps their seat and score instead
    s = reduce(s, { type: 'left', id: 'p1' });
    expect(s.players.find((p) => p.id === 'p1')?.connected).toBe(false);
    s = join(s, 'p1');
    expect(s.players.find((p) => p.id === 'p1')?.connected).toBe(true);
    expect(s.spectators).toEqual(['late']);
  });

  test('spectators promoted at results', () => {
    let s = initialState('ABCD');
    s = join(s, 'p1');
    s = reduce(s, { type: 'fillBots' });
    s = reduce(s, { type: 'start', spec: FALLBACK_SPECS[0]! });
    s = join(s, 'late', 'Late Larry');
    expect(s.spectators).toEqual(['late']);
    s = reduce(s, { type: 'results', ranking: s.players.map((p, i) => ({ id: p.id, score: 10 - i })) });
    expect(s.phase).toBe('results');
    expect(s.spectators).toEqual([]);
    const late = s.players.find((p) => p.id === 'late');
    expect(late?.name).toBe('Late Larry');
    // a bot gave up its seat: still max 4
    expect(s.players).toHaveLength(4);
    expect(humans(s)).toHaveLength(2);
    // round scores were banked
    expect(s.players.find((p) => p.id === 'p1')?.score).toBe(10);
  });

  test('fill with bots tops up to 4', () => {
    let s = initialState('ABCD');
    s = join(s, 'p1');
    s = reduce(s, { type: 'fillBots' });
    expect(s.players).toHaveLength(4);
    expect(s.players.filter((p) => p.isBot)).toHaveLength(3);
    expect(new Set(s.players.map((p) => p.id)).size).toBe(4);
    // idempotent when full
    expect(reduce(s, { type: 'fillBots' }).players).toHaveLength(4);
    // a human joining a full lobby replaces a bot
    s = join(s, 'p2');
    expect(s.players).toHaveLength(4);
    expect(humans(s).map((p) => p.id)).toEqual(['p1', 'p2']);
    // bots off: no fill, bots removed
    let off = reduce(s, { type: 'settings', patch: { bots: false } });
    expect(off.players.every((p) => !p.isBot)).toBe(true);
    off = reduce(off, { type: 'fillBots' });
    expect(off.players).toHaveLength(2);
  });

  test('reduce is pure and the loop returns to the lobby', () => {
    const s0 = join(initialState('ABCD'), 'p1');
    const frozen = JSON.stringify(s0);
    const s1 = reduce(s0, { type: 'start', spec: FALLBACK_SPECS[1]! });
    expect(JSON.stringify(s0)).toBe(frozen);
    expect(s1.round).toBe(1);
    const s2 = reduce(s1, { type: 'results', ranking: [{ id: 'p1', score: 3 }] });
    const s3 = reduce(s2, { type: 'lobby' });
    expect(s3.phase).toBe('lobby');
    expect(s3.players[0]!.score).toBe(3);
  });

  test('a fifth human waits as a spectator in the lobby', () => {
    let s = initialState('ABCD');
    for (const id of ['a', 'b', 'c', 'd', 'e']) s = join(s, id);
    expect(s.players).toHaveLength(4);
    expect(s.spectators).toEqual(['e']);
    s = reduce(s, { type: 'left', id: 'a' }); // lobby: seat freed, spectator promoted
    expect(s.players.map((p) => p.id)).toEqual(['b', 'c', 'd', 'e']);
  });
});
