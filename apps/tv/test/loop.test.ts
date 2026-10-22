import { describe, expect, test } from 'vitest';
import { advanceAccumulator } from '@cadabra/render';
import { BlockRegistry, GameRuntime, makeBots, registerBuiltins, Rng, type Judgement } from '@cadabra/engine';
import { FALLBACK_SPECS, type InputFrame } from '@cadabra/spec';
import { HostLoop, type LoopRuntime } from '../src/play/loop';

class FakeRt implements LoopRuntime {
  state = 'playing';
  steps = 0;
  botCalls: string[] = [];
  inputs: [string, InputFrame][] = [];
  judgements: Judgement[] = [];
  step() { this.steps++; }
  input(id: string, f: InputFrame) { this.inputs.push([id, f]); }
  botInput(id: string): InputFrame { this.botCalls.push(`${this.steps}:${id}`); return { t: this.steps }; }
  pendingJudgements() { return this.judgements; }
}

describe('host loop', () => {
  test('advanceAccumulator drives fixed steps and botInput runs exactly once per step per bot', () => {
    const rt = new FakeRt();
    const loop = new HostLoop(rt, ['bot-1', 'bot-2'], { advance: advanceAccumulator });
    let r = loop.tick(1 / 30, 1, 0); // two 60 Hz steps
    expect(r.steps).toBe(2);
    expect(rt.steps).toBe(2);
    expect(rt.botCalls).toEqual(['0:bot-1', '0:bot-2', '1:bot-1', '1:bot-2']);
    // bot frames are fed back as inputs before each step
    expect(rt.inputs.map(([id]) => id)).toEqual(['bot-1', 'bot-2', 'bot-1', 'bot-2']);
    // slow-mo halves the sim rate; leftover time becomes the render alpha
    r = loop.tick(1 / 60, 0.5, 0);
    expect(r.steps).toBe(0);
    expect(r.alpha).toBeCloseTo(0.5, 5);
    r = loop.tick(1 / 60, 0.5, 0);
    expect(r.steps).toBe(1);
    // hit-stop holds the accumulator
    r = loop.tick(1, 1, 80);
    expect(r.steps).toBe(0);
    // paused: no steps, no bot input
    loop.paused = true;
    const before = rt.botCalls.length;
    expect(loop.tick(0.5, 1, 0).steps).toBe(0);
    expect(rt.botCalls.length).toBe(before);
  });

  test('a long hitch is capped (no spiral of death) and over stops stepping', () => {
    const rt = new FakeRt();
    const loop = new HostLoop(rt, ['bot-1'], { advance: advanceAccumulator });
    const r = loop.tick(2, 1, 0);
    expect(r.steps).toBeLessThanOrEqual(6);
    expect(rt.botCalls.length).toBe(r.steps);
    rt.state = 'over';
    expect(loop.tick(0.1, 1, 0).steps).toBe(0);
  });

  test('new judgements are handed to the host once', () => {
    const rt = new FakeRt();
    const seen: string[] = [];
    const loop = new HostLoop(rt, [], { advance: advanceAccumulator, onJudgement: (j) => seen.push(j.id) });
    rt.judgements = [{ id: 'j1', kind: 'draw', payload: {} }];
    loop.tick(1 / 20, 1, 0);
    loop.tick(1 / 20, 1, 0);
    expect(seen).toEqual(['j1']);
  });

  test('a real fallback round runs deterministically to the end with bots', () => {
    const run = () => {
      const reg = new BlockRegistry();
      registerBuiltins(reg);
      const spec = { ...FALLBACK_SPECS[1]!, durationSec: 12, timeline: [] };
      const bots = makeBots(4, new Rng(1));
      const rt = new GameRuntime(spec, bots, reg, 42);
      const loop = new HostLoop(rt, bots.map((b) => b.id), { advance: advanceAccumulator });
      for (let i = 0; i < 2000 && rt.state !== 'over'; i++) loop.tick(1 / 60, 1, 0);
      return rt.result().ranking.map((p) => `${p.id}:${p.score}`).join(',');
    };
    const a = run();
    expect(a).toBe(run());
  });
});
