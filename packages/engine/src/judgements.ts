import type { Judgement } from './runtime';
import { FALLBACK_QUESTIONS, type TriviaQuestion } from './blocks/trivia';
import type { DrawVerdict } from './blocks/draw-judge';

/** FNV-1a: a tiny deterministic string hash (no Math.random anywhere in the engine). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const STUB_ROASTS = [
  'Bold lines, bolder choices.',
  'A future museum piece. Possibly a museum of mysteries.',
  'The judge squinted and nodded slowly.',
  'Picasso would be confused, in a good way.',
  'Five stars for confidence.',
  'It is giving... something!',
];

/**
 * Deterministic fake result for a pending judgement, for playtests and offline play:
 * 'draw' -> DrawVerdict[] (scores 3..9), 'trivia-gen' -> n bank questions.
 */
export function stubJudgement(j: Judgement): unknown {
  const p = (j.payload ?? {}) as Record<string, unknown>;
  if (j.kind === 'draw') {
    const round = typeof p.round === 'number' ? p.round : 0;
    const entries = Array.isArray(p.entries) ? (p.entries as { playerId?: unknown }[]) : [];
    const out: DrawVerdict[] = [];
    for (const e of entries) {
      if (typeof e?.playerId !== 'string') continue;
      const h = hash(`${e.playerId}:${round}`);
      out.push({ playerId: e.playerId, score: 3 + (h % 7), roast: STUB_ROASTS[(h >>> 8) % STUB_ROASTS.length]! });
    }
    return out;
  }
  const n = typeof p.n === 'number' && p.n > 0 ? Math.min(30, Math.floor(p.n)) : 5;
  const start = hash(typeof p.topic === 'string' ? p.topic : '') % FALLBACK_QUESTIONS.length;
  const out: TriviaQuestion[] = [];
  for (let i = 0; i < n; i++) out.push(FALLBACK_QUESTIONS[(start + i) % FALLBACK_QUESTIONS.length]!);
  return out;
}
