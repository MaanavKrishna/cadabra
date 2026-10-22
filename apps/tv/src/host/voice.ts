// The host's voice: plays host.audio lines one at a time with the caption always on screen.
// Captions work with the voice off, without a URL (synthesis failed) or when audio fails, so
// the room never misses a line. Sound effects are ducked while the host speaks.
export interface VoiceLine { id?: string; text: string; url?: string }

export interface VoiceDeps {
  /** Play one clip; resolves when it ends, rejects on error. */
  play(url: string): Promise<void>;
  /** Show a caption (null hides it). */
  caption(text: string | null): void;
  duck(on: boolean): void;
  /** Settings: host voice on. */
  voiceOn(): boolean;
  wait(ms: number): Promise<void>;
}

/** How long a caption stays up when there is no audio: reading speed, 2–8 s. */
export function captionMs(text: string): number {
  return Math.round(Math.min(8000, Math.max(2000, 900 + text.length * 55)));
}

const MAX_CLIP_MS = 15_000;
const QUEUE_MAX = 6;

export class VoiceQueue {
  private q: VoiceLine[] = [];
  private running?: Promise<void>;

  constructor(private d: VoiceDeps) {}

  get length(): number {
    return this.q.length;
  }

  say(line: VoiceLine): void {
    if (!line.text.trim()) return;
    this.q.push(line);
    if (this.q.length > QUEUE_MAX) this.q.splice(0, this.q.length - QUEUE_MAX); // stale chatter goes
    this.running ??= this.run().finally(() => { this.running = undefined; });
  }

  /** Drop queued lines (the current one finishes). */
  clear(): void {
    this.q = [];
  }

  /** Resolves when the queue is empty. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async run(): Promise<void> {
    for (let line = this.q.shift(); line; line = this.q.shift()) {
      this.d.caption(line.text);
      const minMs = captionMs(line.text);
      if (line.url && this.d.voiceOn()) {
        this.d.duck(true);
        const t0 = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.d.play(line.url),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('clip timeout')), MAX_CLIP_MS); }),
          ]);
        } catch {
          // audio failed: keep the caption up for a reading-time instead
          const left = minMs - (Date.now() - t0);
          if (left > 0) await this.d.wait(left);
        } finally {
          clearTimeout(timer);
          this.d.duck(false);
        }
      } else {
        await this.d.wait(minMs);
      }
    }
    this.d.caption(null);
  }
}

/** Browser deps: one HTMLAudioElement, timers, a caption setter and a duck hook. */
export function browserVoiceDeps(o: { caption(t: string | null): void; duck(on: boolean): void; voiceOn(): boolean }): VoiceDeps {
  const audio = typeof Audio !== 'undefined' ? new Audio() : undefined;
  return {
    ...o,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    play: (url) => new Promise<void>((resolve, reject) => {
      if (!audio) return reject(new Error('no audio'));
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('audio error'));
      audio.src = url;
      audio.play().catch(reject);
    }),
  };
}
