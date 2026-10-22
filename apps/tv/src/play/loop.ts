// Host game loop: the TV is the authority. Wall time feeds a fixed 60 Hz accumulator (scaled by
// the view's slow-mo, held during hit-stop); each step feeds every bot exactly one frame, then
// steps the deterministic runtime. Rendering reads the leftover as the interpolation alpha.
import { DT, type Judgement } from '@cadabra/engine';
import type { InputFrame } from '@cadabra/spec';

/** The slice of GameRuntime the loop uses (fakes implement it in tests). */
export interface LoopRuntime {
  readonly state: string;
  step(): void;
  input(playerId: string, frame: InputFrame): void;
  botInput(playerId: string, skill: number): InputFrame;
  pendingJudgements(): Judgement[];
}

export interface LoopOpts {
  /** advanceAccumulator from @cadabra/render. */
  advance: (acc: number, dtSec: number, timeScale: number, hitStopMs: number) => number;
  /** Bot skill 0..1 (default 0.7). */
  skill?: number;
  /** Max sim steps per frame; extra time is dropped (no spiral of death). */
  maxSteps?: number;
  /** A new engine judgement to resolve out of band (backend or stub). */
  onJudgement?: (j: Judgement) => void;
}

export class HostLoop {
  acc = 0;
  paused = false;
  private asked = new Set<string>();
  private readonly skill: number;
  private readonly maxSteps: number;

  constructor(private rt: LoopRuntime, private bots: readonly string[], private o: LoopOpts) {
    this.skill = o.skill ?? 0.7;
    this.maxSteps = o.maxSteps ?? 5;
  }

  /** Advance by `dtSec` of wall time. Returns sim steps taken and the render alpha. */
  tick(dtSec: number, timeScale: number, hitStopMs: number): { steps: number; alpha: number } {
    if (this.paused || this.rt.state === 'over') return { steps: 0, alpha: this.acc / DT };
    this.acc = this.o.advance(this.acc, Math.min(Math.max(dtSec, 0), 0.25), timeScale, hitStopMs);
    let steps = 0;
    while (this.acc >= DT - 1e-9 && steps < this.maxSteps && this.rt.state !== 'over') {
      for (const id of this.bots) this.rt.input(id, this.rt.botInput(id, this.skill));
      this.rt.step();
      this.acc -= DT;
      steps++;
      this.collectJudgements();
    }
    if (steps === this.maxSteps && this.acc >= DT) this.acc = 0;
    if (this.acc < 0) this.acc = 0;
    return { steps, alpha: Math.min(1, this.acc / DT) };
  }

  private collectJudgements(): void {
    if (!this.o.onJudgement) return;
    for (const j of this.rt.pendingJudgements()) {
      if (this.asked.has(j.id)) continue;
      this.asked.add(j.id);
      this.o.onJudgement(j);
    }
  }
}
