// The AI forge flow (Task 19 / N3), as pure functions: Idea Storm -> pitches -> vote -> forge ->
// play. The reducer lives in state/machine.ts (ForgeInfo); this module holds the timings, the
// forgeId filter, the vote tally and tie-break, and the forge screen's step list.
import type { BackendToClient, GameSpec, Pitch } from '@cadabra/spec';

export const STORM_SEC = 20;
export const VOTE_SEC = 15;
/** No pitches this long after the storm ends: play a built-in game instead. */
export const PITCH_TIMEOUT_MS = 15_000;
/** No spec this long after the vote closes: play a built-in game instead. */
export const FORGE_TIMEOUT_MS = 30_000;
/** The forge screen shows at least this long, even when the game was ready before the vote. */
export const FORGE_MIN_MS = 2600;
/** Once every seated phone has voted, close the vote after this pause. */
export const ALL_VOTED_MS = 1500;

/** Suggestions for an empty storm (and the phone's chips). */
export const DEFAULT_INGREDIENTS = ['laser sharks', 'zero gravity', 'lava floor'];

/** The stages the forge screen always shows, in order; backend step labels slot in between. */
export const FORGE_STEPS = ['Reading the ingredients', 'Picking blocks', 'Bots are playtesting', 'Game ready'] as const;

export interface ForgeProgress { step: string; pct: number; steps: string[] }

export interface ForgeInfo {
  /** Set from the first forge.pitches after this storm; later messages must match it. */
  id?: string;
  /** Pitch id that won the vote. */
  winner?: string;
  /** The TV's own vote (D-pad Select): breaks ties. */
  tvVote?: number;
  progress: Record<string, ForgeProgress>;
  /** Ready specs by pitch id (the backend designs all three; the winner's is used). */
  ready: Record<string, { spec: GameSpec; fallback: boolean }>;
  /** Generated art by pitch id: key -> url. */
  art: Record<string, Record<string, string>>;
}

export const emptyForge = (): ForgeInfo => ({ progress: {}, ready: {}, art: {} });

type ForgeMsg = Extract<BackendToClient, { t: 'forge.pitches' | 'forge.progress' | 'forge.ready' | 'forge.art' }>;

export const isForgeMsg = (m: BackendToClient): m is ForgeMsg =>
  m.t === 'forge.pitches' || m.t === 'forge.progress' || m.t === 'forge.ready' || m.t === 'forge.art';

/**
 * Does `m` belong to the current forge? forge.pitches is only taken while waiting for pitches
 * (and adopts its forgeId); everything else must match the adopted id (or, when the backend sent
 * no id, name one of the current pitches).
 */
export function belongs(f: ForgeInfo, pitches: readonly Pitch[], m: ForgeMsg, waitingForPitches: boolean): boolean {
  if (m.t === 'forge.pitches') return waitingForPitches && (!f.id || !m.forgeId || m.forgeId === f.id);
  if (f.id && m.forgeId && m.forgeId !== f.id) return false;
  if (!f.id && m.forgeId) return false; // a forge we never got pitches for
  return pitches.some((p) => p.id === m.pitchId);
}

/** Vote counts per pitch index (votes: phone id -> index). */
export function tally(votes: Record<string, number>, n: number): number[] {
  const out = Array.from({ length: n }, () => 0);
  for (const v of Object.values(votes)) if (v >= 0 && v < n) out[v]!++;
  return out;
}

/**
 * The winning pitch index. Most phone votes wins; a tie (or no votes at all) goes to the TV's vote
 * when it is among the tied, else to `focused` when tied, else the first tied pitch.
 */
export function pickWinner(votes: Record<string, number>, n: number, tvVote?: number, focused?: number): number {
  if (n <= 0) return 0;
  const t = tally(votes, n);
  const best = Math.max(...t);
  const tied = t.map((c, i) => (c === best ? i : -1)).filter((i) => i >= 0);
  if (tied.length === 1) return tied[0]!;
  if (tvVote !== undefined && tied.includes(tvVote)) return tvVote;
  if (focused !== undefined && tied.includes(focused)) return focused;
  return tied[0]!;
}

/** Merge one forge.progress into a pitch's progress (pct never goes backwards; steps dedupe). */
export function addProgress(p: ForgeProgress | undefined, step: string, pct: number): ForgeProgress {
  const steps = p?.steps ?? [];
  return {
    step,
    pct: Math.max(p?.pct ?? 0, Math.min(100, pct)),
    steps: steps.includes(step) ? steps : [...steps, step].slice(-8),
  };
}

export interface StepRow { label: string; state: 'done' | 'active' | 'todo' }

/**
 * The forge screen's step list: the four headline stages, ticked off by pct, with the backend's
 * latest step label shown under the active one.
 */
export function stepRows(p: ForgeProgress | undefined, ready: boolean): StepRow[] {
  const pct = ready ? 100 : p?.pct ?? 0;
  // backend pcts: 5 reading, 15 picking blocks, 60 playtesting, 90 final playtest, 100 ready;
  // a step label that names a stage wins (the game is "ready" only with the spec in hand)
  const named = FORGE_STEPS.indexOf((p?.step ?? '') as (typeof FORGE_STEPS)[number]);
  const active = ready ? 3 : Math.min(2, Math.max(named, pct >= 60 ? 2 : pct >= 15 ? 1 : 0));
  return FORGE_STEPS.map((label, i) => ({ label, state: i < active || (ready && i === 3) ? 'done' : i === active ? 'active' : 'todo' }));
}

/** Displayed percent: never 100 until the spec is in hand. */
export function shownPct(p: ForgeProgress | undefined, ready: boolean): number {
  if (ready) return 100;
  return Math.max(4, Math.min(96, Math.round(p?.pct ?? 0)));
}

/** A built-in game to play when the forge cannot deliver (deterministic per seed). */
export function fallbackGame<T>(games: readonly T[], seed: number): T {
  return games[Math.abs(Math.floor(seed)) % games.length]!;
}
