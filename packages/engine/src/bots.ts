import type { Player } from './block';
import type { Rng } from './rng';
import type { GameRuntime } from './runtime';

/**
 * Neon arcade bot handles (≤ 7 characters, they fit any name tag). A bot's avatar key is
 * `bot:<index in this list>`, so a handle always wears the same face from the fallback avatar pack.
 */
export const BOT_NAMES: readonly string[] = ['VOLT', 'NOVA', 'BLITZ', 'PIXEL', 'ECHO', 'FLUX', 'RAZE', 'ZERO'];

/**
 * `n` bot players with distinct personalities (shuffled by `rng`; past the list, names get a
 * number suffix). Ids are `bot-1..n`, so they never collide with phone players.
 */
export function makeBots(n: number, rng: Rng): Player[] {
  const order = BOT_NAMES.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const out: Player[] = [];
  for (let i = 0; i < n; i++) {
    const k = order[i % order.length]!;
    const lap = Math.floor(i / order.length);
    out.push({
      id: `bot-${i + 1}`,
      name: lap === 0 ? BOT_NAMES[k]! : `${BOT_NAMES[k]!} ${lap + 1}`,
      avatar: `bot:${k}`,
      isBot: true,
      connected: true,
      score: 0,
    });
  }
  return out;
}

/**
 * Feed one bot frame per bot for the coming step (call once per step, before rt.step()).
 * Plausibility (wobbly aim, forgotten tiptoes, wrong answers, late reactions) comes from
 * each block's skill-scaled bot logic on the runtime's seeded rng, so a driven round stays
 * deterministic and replayable. Different skills: call once per skill group, in a fixed order.
 */
export function driveBots(rt: GameRuntime, bots: readonly Player[], skill: number): void {
  if (rt.state === 'over') return;
  for (const b of bots) rt.input(b.id, rt.botInput(b.id, skill));
}
