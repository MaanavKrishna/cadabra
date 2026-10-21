export type FxEvent =
  | { kind: 'particles'; preset: 'sparkle' | 'smoke' | 'burst' | 'splash' | 'confetti'; x: number; y: number }
  | { kind: 'shake'; strength: number }
  | { kind: 'flash'; color: string }
  | { kind: 'sfx'; name: string }
  | { kind: 'slowmo'; ms: number }
  | { kind: 'banner'; text: string };

/** Feeds host roast + results. `t` is sim time in seconds. */
export interface GameEvent {
  t: number;
  type: string;
  player?: string;
  data?: Record<string, unknown>;
}

/** FIFO of render-side effects, drained once per rendered frame. */
export class FxQueue {
  private q: FxEvent[] = [];

  push(e: FxEvent): void {
    this.q.push(e);
  }

  drain(): FxEvent[] {
    const out = this.q;
    this.q = [];
    return out;
  }
}
