/**
 * Dev-only visual check for @cadabra/render: a real GameRuntime with bots, drawn by GameView.
 * `npm -w @cadabra/tv run dev`, then open /render-demo.html?game=heist|dodge|sweep|race|tug|quiz|draw
 * (&bots=1..8 sets the bot count, default 4; &dur=N shortens the round to N s)
 */
import { BlockRegistry, GameRuntime, Rng, driveBots, makeBots, registerBuiltins, stubJudgement, DT } from '@cadabra/engine';
import type { GameSpec } from '@cadabra/spec';
import { GameView, advanceAccumulator } from '@cadabra/render';
import { GAMES } from './demo-games';

const qs = new URLSearchParams(location.search);
const game = qs.get('game') ?? 'heist';
const botCount = Math.max(1, Math.min(8, Number(qs.get('bots') ?? 4) || 4));
const base = (GAMES[game] ?? GAMES.heist!)();
// &dur=N shortens the round (quick look at the final-10-s finale)
const dur = Number(qs.get('dur'));
const spec: GameSpec = dur >= 12 ? { ...base, durationSec: dur, timeline: [] } : base;
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
  bots = makeBots(botCount, new Rng(seed++));
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
  // host contract: slow-mo scales the accumulator, hit-stop holds it (the sim stays fixed-step)
  acc = advanceAccumulator(acc, dt, view.timeScale, view.hitStopMs);
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
