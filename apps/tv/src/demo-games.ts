/** Shared demo game specs (render-demo and the device benchmark). */
import { FALLBACK_SPECS, type BlockUse, type GameSpec } from '@cadabra/spec';
import heistJson from '../../../packages/spec/test/fixtures/heist.json';

export const heist = heistJson as unknown as GameSpec;

function variant(blocks: BlockUse[], kind: GameSpec['arena']['kind'], over: Partial<GameSpec> = {}): GameSpec {
  return {
    ...heist,
    id: `demo-${kind}`,
    arena: { kind, width: 1280, height: 720 },
    blocks,
    modifiers: [],
    timeline: [
      { atSec: 20, kind: 'surprise', params: {}, hostLine: 'Surprise! Things just got spicy!' },
      { atSec: 50, kind: 'twist', params: {}, hostLine: 'Final stretch!' },
    ],
    durationSec: 60,
    ...over,
  };
}

const neon = { bg: '#120b2e', primary: '#4cc9f0', accent: '#f72585', glow: '#ffd166', text: '#ffffff' } as const;
export const GAMES: Record<string, () => GameSpec> = {
  heist: () => heist,
  dodge: () => variant([{ block: 'dodge', params: { pattern: 'rain', onHit: 'stun', safeZones: 1 } }], 'topdown', {
    theme: { ...heist.theme, palette: { ...neon }, sfxSet: 'arcade' },
  }),
  sweep: () => variant([{ block: 'dodge', params: { pattern: 'ring', startRate: 1.2 } }, { block: 'collect', params: {} }], 'topdown', {
    theme: { ...heist.theme, palette: { bg: '#0b2a1a', primary: '#80ed99', accent: '#ff5d8f', glow: '#ffe66d', text: '#ffffff' } },
  }),
  race: () => variant([{ block: 'race', params: { laneCount: 4 } }], 'lanes', {
    theme: { ...heist.theme, palette: { bg: '#0d1b3d', primary: '#3d8bff', accent: '#ff4d6d', glow: '#ffd166', text: '#ffffff' } },
  }),
  tug: () => variant([{ block: 'tug', params: {} }], 'tug', { teams: 2 }),
  quiz: () => variant([{ block: 'trivia', params: {} }], 'quiz', { theme: { ...heist.theme, palette: { ...neon } } }),
  // the three built-in fallback games (what players see without AI)
  'ladoo-heist': () => FALLBACK_SPECS[0]!,
  'lava-penguins': () => FALLBACK_SPECS[1]!,
  'bear-tug': () => FALLBACK_SPECS[2]!,
  draw: () => variant([{ block: 'draw-judge', params: {} }], 'canvas', { theme: { ...heist.theme, palette: { ...neon } } }),
};

