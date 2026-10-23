// Party mode (N3 §3): a playlist of short rounds drawn from the built-in games, with a points
// table that carries across rounds, standings between rounds and a grand champion at the end.
// Pure: the app keeps a PartyRun and feeds it each round's ranking.

export const PARTY_ROUNDS = 4;
/** Round lengths cycle through these (35–45 s each). */
export const PARTY_SECS = [40, 35, 45, 40] as const;
/** Team games: each member of the winning team / a drawn team / the losing team gets this. */
export const TEAM_POINTS = { win: 3, draw: 2, lose: 1 } as const;

export interface PartyRound { gameId: string; durationSec: number }

export interface PartyRun {
  rounds: PartyRound[];
  /** Index of the round being played (or just played). */
  index: number;
  /** Party points by player id. */
  points: Record<string, number>;
  /** Points each player earned in the last finished round. */
  last: Record<string, number>;
  /** Rounds finished so far. */
  played: number;
}

export interface RoundResult { id: string; score: number; team?: number }

/** Shuffle (seeded) and take `n` distinct games, repeating the list only when it is shorter than n. */
export function newParty(gameIds: readonly string[], seed: number, n = PARTY_ROUNDS): PartyRun {
  if (gameIds.length === 0) throw new Error('party needs at least one game');
  let s = (seed >>> 0) || 1;
  const rnd = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0x1_0000_0000;
  };
  const rounds: PartyRound[] = [];
  let bag: string[] = [];
  while (rounds.length < n) {
    if (bag.length === 0) {
      bag = [...gameIds];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [bag[i], bag[j]] = [bag[j]!, bag[i]!];
      }
      // never the same game twice in a row across a refill
      if (rounds.length && bag.length > 1 && bag[0] === rounds[rounds.length - 1]!.gameId) bag.push(bag.shift()!);
    }
    rounds.push({ gameId: bag.shift()!, durationSec: PARTY_SECS[rounds.length % PARTY_SECS.length]! });
  }
  return { rounds, index: 0, points: {}, last: {}, played: 0 };
}

/**
 * Party points for one round. Free-for-all: by place, N players -> N, N-1, …, 1 (equal scores share
 * the better place). Team games (winnerTeam given or teams present): TEAM_POINTS per member.
 */
export function roundPoints(ranking: readonly RoundResult[], winnerTeam?: number): Record<string, number> {
  const out: Record<string, number> = {};
  const n = ranking.length;
  const teamGame = winnerTeam !== undefined || ranking.some((r) => r.team !== undefined);
  if (teamGame) {
    for (const r of ranking) {
      out[r.id] = winnerTeam === undefined || r.team === undefined ? TEAM_POINTS.draw : r.team === winnerTeam ? TEAM_POINTS.win : TEAM_POINTS.lose;
    }
    return out;
  }
  let place = 0;
  ranking.forEach((r, i) => {
    if (i === 0 || r.score !== ranking[i - 1]!.score) place = i;
    out[r.id] = n - place;
  });
  return out;
}

/** Add a finished round to the run. */
export function finishRound(run: PartyRun, ranking: readonly RoundResult[], winnerTeam?: number): PartyRun {
  const last = roundPoints(ranking, winnerTeam);
  const points = { ...run.points };
  for (const [id, p] of Object.entries(last)) points[id] = (points[id] ?? 0) + p;
  return { ...run, points, last, played: run.played + 1 };
}

/** Move on to the next round (after the standings screen). */
export const nextRound = (run: PartyRun): PartyRun => ({ ...run, index: Math.min(run.rounds.length - 1, run.index + 1) });

export const isOver = (run: PartyRun): boolean => run.played >= run.rounds.length;

export interface StandingRow { id: string; points: number; gained: number; rank: number; prevRank: number }

/** Standings, best first; `prevRank` is the rank before the last round (for the climb animation). */
export function standings(run: PartyRun, ids: readonly string[]): StandingRow[] {
  const rankOf = (score: (id: string) => number) => {
    const sorted = [...ids].sort((a, b) => score(b) - score(a) || ids.indexOf(a) - ids.indexOf(b));
    const rank = new Map<string, number>();
    sorted.forEach((id, i) => {
      const prev = sorted[i - 1];
      rank.set(id, i > 0 && score(prev!) === score(id) ? rank.get(prev!)! : i + 1);
    });
    return { sorted, rank };
  };
  const now = rankOf((id) => run.points[id] ?? 0);
  const before = rankOf((id) => (run.points[id] ?? 0) - (run.last[id] ?? 0));
  return now.sorted.map((id) => ({
    id, points: run.points[id] ?? 0, gained: run.last[id] ?? 0, rank: now.rank.get(id)!, prevRank: before.rank.get(id)!,
  }));
}

/** The grand champion(s): everyone sharing the top points total. */
export function champions(run: PartyRun, ids: readonly string[]): string[] {
  const rows = standings(run, ids);
  return rows.filter((r) => r.rank === 1).map((r) => r.id);
}
