// Prebuilt fallback games: the Forge (backend) reskins one when AI design fails or runs out of time,
// and the TV bundles the same specs for offline play. Each one passes the strict bot playtest
// (checked by apps/backend/test/forge.test.ts).
import type { GameSpec, Pitch } from '../game-spec';
import ladooHeist from './ladoo-heist.json';
import lavaPenguins from './lava-penguins.json';
import bearTug from './bear-tug.json';

export const FALLBACK_SPECS: readonly GameSpec[] = [
  ladooHeist as unknown as GameSpec,
  lavaPenguins as unknown as GameSpec,
  bearTug as unknown as GameSpec,
];

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/**
 * Fallback whose blocks best overlap `blocksSketch` (Jaccard; ties keep library order).
 * `seats` = players in the round including bots (default 4). Team games (tug) only pass the bot
 * playtest as 2 vs 2, so they are skipped for fewer seats.
 */
export function pickFallback(blocksSketch: readonly string[], opts: { seats?: number } = {}): GameSpec {
  const seats = opts.seats ?? 4;
  const want = new Set(blocksSketch);
  let best = FALLBACK_SPECS[0]!;
  let bestScore = -1;
  for (const spec of FALLBACK_SPECS) {
    if (spec.teams === 2 && seats < 4) continue;
    const have = new Set(spec.blocks.map((b) => b.block));
    const inter = [...have].filter((b) => want.has(b)).length;
    const union = new Set([...have, ...want]).size;
    const score = union ? inter / union : 0;
    if (score > bestScore) { best = spec; bestScore = score; }
  }
  return best;
}

/** Sprite keys a block draws, by role. */
const ITEM_PARAMS = ['itemSprite'];
const THREAT_PARAMS = ['guardSprite', 'hazardSprite'];

/**
 * Reskin a fallback spec with the pitch: title, hook, palette, key art, host intro/finale and
 * (when ingredients are given) the item/threat sprite prompts. Rules, controls and timeline are
 * untouched, so the result plays exactly like the playtested base.
 */
export function reskinFallback(
  base: GameSpec, pitch: Pitch, opts: { id: string; ingredients?: readonly string[] } ,
): GameSpec {
  const spec = structuredClone(base) as GameSpec;
  const ing = (opts.ingredients ?? []).map((s) => s.trim()).filter(Boolean);
  spec.id = opts.id;
  spec.title = clip(pitch.title, 40);
  spec.hook = clip(pitch.hook, 120);
  spec.theme.palette = { ...pitch.palette };
  spec.theme.keyArtPrompt = clip(pitch.keyArtPrompt, 600);
  spec.host.intro = clip(`Welcome to ${pitch.title}! ${pitch.hook}`, 240);
  spec.host.finale = clip(`Final ten seconds of ${pitch.title}! Every point counts double. Go go go!`, 240);
  const view = spec.arena.kind === 'topdown' ? 'top-down cartoon' : 'side view cartoon';
  const sprite = (key: unknown, thing: string | undefined) => {
    if (typeof key === 'string' && thing && key in spec.theme.sprites) {
      spec.theme.sprites[key] = clip(`${thing}, ${view}, no text`, 300);
    }
  };
  for (const b of spec.blocks) {
    for (const p of ITEM_PARAMS) sprite(b.params[p], ing[0]);
    for (const p of THREAT_PARAMS) sprite(b.params[p], ing[1] ?? ing[0]);
  }
  if (spec.arena.kind === 'tug' && ing[0]) {
    const rope = Object.keys(spec.theme.sprites).find((k) => k !== 'player');
    if (rope) spec.theme.sprites[rope] = clip(`giant rope with a ${ing[0]} on it, side view cartoon, no text`, 300);
  }
  spec.origin = { ingredients: ing.slice(0, 8), wild: false };
  return spec;
}
