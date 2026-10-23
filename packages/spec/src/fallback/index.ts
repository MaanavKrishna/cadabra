// Prebuilt fallback games: the Forge (backend) reskins one when AI design fails or runs out of time,
// and the TV bundles the same specs for offline play. Each one passes the strict bot playtest
// (checked by apps/backend/test/forge.test.ts).
import type { GameSpec, Pitch } from '../game-spec';
import ringOut from './ring-out.json';
import overload from './overload.json';
import paintWars from './paint-wars.json';
import coreRush from './core-rush.json';
import neonDash from './neon-dash.json';
import rocketBall from './rocket-ball.json';
import crateCrash from './crate-crash.json';

/**
 * The arcade lineup: RING OUT (FFA bumper sumo, toybox), OVERLOAD (hot potato, cosmos), PAINT
 * WARS (2v2 territory, retro), CORE RUSH (2v2 capture/carry, cosmos), NEON DASH (lane race,
 * neon), ROCKET BALL (2v2 physics car-soccer, neon), CRATE CRASH (FFA physics crate smash,
 * toybox). Every one also plays as a 30–45 s quick-fire round (party playlist).
 */
export const FALLBACK_SPECS: readonly GameSpec[] = [
  ringOut as unknown as GameSpec,
  overload as unknown as GameSpec,
  paintWars as unknown as GameSpec,
  coreRush as unknown as GameSpec,
  neonDash as unknown as GameSpec,
  rocketBall as unknown as GameSpec,
  crateCrash as unknown as GameSpec,
];

/** The retired fallbacks and the neon game that replaced each (for old links / share codes). */
export const LEGACY_FALLBACK_IDS: Readonly<Record<string, string>> = {
  'fallback-ladoo-heist': 'fallback-core-rush',
  'fallback-lava-penguins': 'fallback-ring-out',
  'fallback-bear-tug': 'fallback-paint-wars',
};

/** A fallback by id (legacy ids map to their replacement). */
export function fallbackById(id: string): GameSpec | undefined {
  const want = LEGACY_FALLBACK_IDS[id] ?? id;
  return FALLBACK_SPECS.find((s) => s.id === want);
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** Pitch words that point at one neon mode (breaks block-overlap ties: three games are arena-move only). */
const MODE_WORDS: readonly [string, RegExp][] = [
  ['fallback-overload', /\b(overload|hot ?potato|bomb|fuse|tag|pass|explod\w*|detonat\w*|unstable)\b/i],
  ['fallback-paint-wars', /\b(paint\w*|colou?r\w*|territor\w*|splat\w*|splash\w*|graffiti|tiles?)\b/i],
  ['fallback-neon-dash', /\b(race|racing|lane|lanes|run|sprint|finish|laser)\b/i],
  ['fallback-core-rush', /\b(carry|heist|steal\w*|bank|base|capture|grab|loot|rush|cores?)\b/i],
  ['fallback-rocket-ball', /\b(ball|soccer|football|goals?|kick\w*|rocket|hockey|puck|sports?)\b/i],
  ['fallback-crate-crash', /\b(crates?|box(es)?|stack\w*|tower\w*|smash\w*|barrels?|blocks?|lego|topple\w*)\b/i],
  ['fallback-ring-out', /\b(ring|sumo|shove|push|knock\w*|edge|arena|bump\w*|crumbl\w*)\b/i],
];

/**
 * Fallback whose blocks best overlap `blocksSketch` (Jaccard), with `hint` (pitch title + hook)
 * nudging toward the mode its words name; ties keep library order.
 * `seats` = players in the round including bots (default 4). Team games only pass the bot
 * playtest as 2 vs 2, so they are skipped for fewer seats.
 */
export function pickFallback(blocksSketch: readonly string[], opts: { seats?: number; hint?: string } = {}): GameSpec {
  const seats = opts.seats ?? 4;
  const want = new Set(blocksSketch);
  let best = FALLBACK_SPECS[0]!;
  let bestScore = -1;
  for (const spec of FALLBACK_SPECS) {
    if (spec.teams === 2 && seats < 4) continue;
    const have = new Set(spec.blocks.map((b) => b.block));
    const inter = [...have].filter((b) => want.has(b)).length;
    const union = new Set([...have, ...want]).size;
    let score = union ? inter / union : 0;
    const words = MODE_WORDS.find(([id]) => id === spec.id)?.[1];
    if (opts.hint && words?.test(opts.hint)) score += 0.3;
    if (score > bestScore) { best = spec; bestScore = score; }
  }
  return best;
}

/** Sprite keys a block draws, by role. */
const ITEM_PARAMS = ['itemSprite'];
const THREAT_PARAMS = ['guardSprite', 'hazardSprite', 'obstacleSprite'];

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
  spec.host.intro = clip(`${pitch.title}: ${base.host.intro}`, 240);
  spec.host.finale = clip(`Final ten seconds of ${pitch.title}! Every point counts double. Go go go!`, 240);
  const view = spec.arena.kind === 'topdown' ? 'top-down' : 'side view';
  const sprite = (key: unknown, thing: string | undefined) => {
    if (typeof key === 'string' && thing && key in spec.theme.sprites) {
      spec.theme.sprites[key] = clip(`glowing neon outline of a ${thing}, ${view}, vector arcade style on deep navy, no text`, 300);
    }
  };
  for (const b of spec.blocks) {
    for (const p of ITEM_PARAMS) sprite(b.params[p], ing[0]);
    for (const p of THREAT_PARAMS) sprite(b.params[p], ing[1] ?? ing[0]);
  }
  // arena-move modes draw a core (overload) or floor tiles: theme the core after the first ingredient
  if (ing[0] && 'core-unstable' in spec.theme.sprites) {
    spec.theme.sprites['core-unstable'] = clip(`glowing neon ${ing[0]}-shaped energy core crackling with sparks, top-down, vector arcade style, no text`, 300);
  }
  spec.origin = { ingredients: ing.slice(0, 8), wild: false };
  return spec;
}
