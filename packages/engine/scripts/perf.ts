/**
 * Physics step micro-benchmark: 4 players + 40 dynamic bodies, a burst of 60 steps (1 s of play)
 * after a warm-up, reporting ms per step.   npx tsx packages/engine/scripts/perf.ts [bursts=20]
 */
import { FALLBACK_SPECS, type GameSpec } from '@cadabra/spec';
import { BlockRegistry, GameRuntime, Rng, makeBots, registerBuiltins } from '../src/index';

export function perfSpec(): GameSpec {
  const base = structuredClone(FALLBACK_SPECS.find((s) => s.id === 'fallback-rocket-ball')!);
  base.world = {
    physics: { restitution: 0.8 },
    props: [
      { kind: 'crate', count: 12, layout: 'scatter' }, { kind: 'ball', count: 12, layout: 'scatter' },
      { kind: 'barrel', count: 8, layout: 'scatter', respawnSec: 2 }, { kind: 'crate', count: 7, layout: 'center' },
    ],
  };
  return base;
}

/** Mean and worst ms per step over `bursts` × 60 steps (after a 120-step warm-up). */
export function benchPhysics(bursts = 20): { meanMs: number; worstBurstMs: number; bodies: number } {
  const reg = new BlockRegistry();
  registerBuiltins(reg);
  const bots = makeBots(4, new Rng(7));
  const rt = new GameRuntime(perfSpec(), bots, reg, 7);
  const drive = () => { bots.forEach((b, k) => rt.input(b.id, rt.botInput(b.id, 0.5 + k * 0.1))); rt.step(); };
  for (let i = 0; i < 120; i++) drive();
  const bodies = rt.snapshot().entities.filter((e) => e.props.body === 'dynamic').length;
  let total = 0, worst = 0;
  for (let b = 0; b < bursts; b++) {
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) drive();
    const ms = (performance.now() - t0) / 60;
    total += ms;
    worst = Math.max(worst, ms);
  }
  return { meanMs: total / bursts, worstBurstMs: worst, bodies };
}

if (process.argv[1]?.endsWith('perf.ts')) {
  const r = benchPhysics(Number(process.argv[2] ?? 20));
  console.log(`4 players + ${r.bodies} dynamic bodies: ${r.meanMs.toFixed(3)} ms/step mean, ${r.worstBurstMs.toFixed(3)} ms/step worst 60-step burst (budget 16.7 ms/frame)`);
}
