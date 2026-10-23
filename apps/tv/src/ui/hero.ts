// Hero backgrounds: stills baked from the real GameView in each game's own look (re-baked in R3),
// with 4 bots playing, HUD off, cropped to the action, 1600x900 JPEG; plus montages for Create,
// Party, Arcade and a calm wash. The home tiles use the same stills as thumbnails.
// A still costs nothing per frame on the stick; a live GameView behind the menu would cost a
// 1.5 s theme load per focus change and most of the GPU budget (docs/DEVICE_LIMITS.md).
import ringOut from '../hero/ring-out.jpg';
import overload from '../hero/overload.jpg';
import paintWars from '../hero/paint-wars.jpg';
import coreRush from '../hero/core-rush.jpg';
import neonDash from '../hero/neon-dash.jpg';
import rocketBall from '../hero/rocket-ball.jpg';
import crateCrash from '../hero/crate-crash.jpg';
import create from '../hero/create.jpg';
import party from '../hero/party.jpg';
import arcade from '../hero/arcade.jpg';
import calm from '../hero/calm.jpg';

export const HERO = { create, party, arcade, calm } as const;

const GAME_STILLS: Record<string, string> = {
  'fallback-ring-out': ringOut,
  'fallback-overload': overload,
  'fallback-paint-wars': paintWars,
  'fallback-core-rush': coreRush,
  'fallback-neon-dash': neonDash,
  'fallback-rocket-ball': rocketBall,
  'fallback-crate-crash': crateCrash,
};

/** The baked still for a built-in game, if any. */
export const gameStill = (specId: string | undefined): string | undefined => (specId ? GAME_STILLS[specId] : undefined);

/** Warm the decode cache so the first crossfade does not hitch. */
export function preloadHeroes(): void {
  for (const url of [...Object.values(GAME_STILLS), ...Object.values(HERO)]) {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  }
}

/** "RING OUT" -> "Ring Out" (shouty built-in titles read better as a light wordmark). */
export function displayTitle(t: string): string {
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
}
