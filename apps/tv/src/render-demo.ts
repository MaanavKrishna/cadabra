/**
 * Dev-only visual check for @cadabra/render: a real GameRuntime with bots, drawn by GameView.
 * `npm -w @cadabra/tv run dev`, then open /render-demo.html?game=heist|dodge|sweep|race|tug|quiz|draw
 */
import { BlockRegistry, GameRuntime, Rng, driveBots, makeBots, registerBuiltins, stubJudgement, DT } from '@cadabra/engine';
import type { BlockUse, GameSpec } from '@cadabra/spec';
import { GameView } from '@cadabra/render';
import heistJson from '../../../packages/spec/test/fixtures/heist.json';

const heist = heistJson as unknown as GameSpec;

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
const GAMES: Record<string, () => GameSpec> = {
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
  draw: () => variant([{ block: 'draw-judge', params: {} }], 'canvas', { theme: { ...heist.theme, palette: { ...neon } } }),
};

const game = new URLSearchParams(location.search).get('game') ?? 'heist';
const spec = (GAMES[game] ?? GAMES.heist!)();
const registry = new BlockRegistry();
registerBuiltins(registry);

const view = new GameView(document.getElementById('stage')!, {
  internalW: 1280, internalH: 720, arena: { width: spec.arena.width, height: spec.arena.height },
});
(window as unknown as { view: GameView }).view = view; // dev inspection
const t0 = performance.now();
await view.loadTheme(spec.theme, {});
console.log(`loadTheme ${Math.round(performance.now() - t0)} ms`);

let seed = 7;
let rt: GameRuntime;
let bots: ReturnType<typeof makeBots>;
function start(): void {
  bots = makeBots(4, new Rng(seed++));
  rt = new GameRuntime(spec, bots, registry, seed);
}
start();

let acc = 0;
let last = performance.now();
let overAt = 0;
const fpsEl = document.getElementById('fps')!;
let frames = 0, fpsT = last;
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt * view.timeScale;
  let steps = 0;
  while (acc >= DT && steps < 5) {
    driveBots(rt, bots, 0.7);
    for (const j of rt.pendingJudgements()) rt.resolveJudgement(j.id, stubJudgement(j));
    rt.step();
    acc -= DT;
    steps++;
  }
  if (steps === 5) acc = 0;
  view.render(rt.snapshot(), rt.drainFx(), acc / DT);
  if (rt.state === 'over') {
    overAt ||= now;
    if (now - overAt > 3000) {
      overAt = 0;
      start();
    }
  }
  frames++;
  if (now - fpsT > 1000) {
    fpsEl.textContent = `${Math.round((frames * 1000) / (now - fpsT))} fps · ${view.particleCount} particles`;
    frames = 0;
    fpsT = now;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
