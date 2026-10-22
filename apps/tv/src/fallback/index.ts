// Prebuilt games for Quick Play and offline play. The specs live in @cadabra/spec (one copy,
// shared with the backend's Forge fallback); this module adds TV-side metadata and key art.
import { FALLBACK_SPECS, type GameSpec } from '@cadabra/spec';
export { keyArtFor, type KeyArt, type HeroSprite } from './art';

export interface GameCard {
  spec: GameSpec;
  /** Short facts under the title. */
  meta: string[];
  /** Seats the game needs to play well (team games: 4). */
  seats: number;
}

const mode = (s: GameSpec) => (s.teams === 2 ? 'Team tug-of-war' : s.win.type === 'lastStanding' ? 'Last one standing' : 'Free-for-all');

export function cardFor(spec: GameSpec, roundSec?: number): GameCard {
  const controls = spec.controller
    .map((w) => ('label' in w && w.label ? w.label : w.kind === 'joystick' ? 'Stick' : w.kind))
    .slice(0, 2)
    .join(' + ');
  return {
    spec,
    meta: [mode(spec), `${roundSec ?? spec.durationSec} s`, controls],
    seats: spec.teams === 2 ? 4 : 2,
  };
}

export const QUICK_GAMES: readonly GameSpec[] = FALLBACK_SPECS;

/**
 * The spec as played tonight: the room's round length replaces the authored one, and timeline
 * beats are re-timed to keep the mid-round surprise in the middle and the twist in the final 10 s.
 */
export function withRoundLength(spec: GameSpec, roundSec: number): GameSpec {
  const d = Math.max(30, Math.min(180, Math.round(roundSec)));
  if (d === spec.durationSec) return spec;
  const k = d / spec.durationSec;
  const timeline = spec.timeline.map((ev) => {
    const lastTen = ev.atSec >= spec.durationSec - 10;
    return { ...ev, atSec: lastTen ? Math.max(0, d - (spec.durationSec - ev.atSec)) : Math.round(ev.atSec * k) };
  });
  return { ...spec, durationSec: d, timeline };
}
