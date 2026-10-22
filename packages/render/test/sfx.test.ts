import { describe, expect, test, vi } from 'vitest';

class FakeAC {
  static last: FakeAC;
  state = 'suspended';
  sampleRate = 8000;
  currentTime = 0;
  destination = {};
  resumed = 0;
  buffers = 0;
  played = 0;
  constructor() {
    FakeAC.last = this;
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => undefined };
  }
  createBuffer(_c: number, len: number) {
    this.buffers++;
    return { getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() {
    this.played++;
    return { buffer: null, playbackRate: { value: 1 }, connect: () => undefined, disconnect: () => undefined, start: () => undefined, onended: null };
  }
  resume() {
    this.resumed++;
    return Promise.resolve();
  }
}

describe('sfx with WebAudio', () => {
  test('prewarm synthesises the bank; nothing plays until the context is running', async () => {
    vi.resetModules();
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAC;
    const { prewarmSfx, sfx, SFX_BANK } = await import('../src/sfx');
    prewarmSfx();
    const ac = FakeAC.last;
    expect(ac.buffers).toBe(Object.keys(SFX_BANK).length);
    sfx('coin');
    expect(ac.played).toBe(0);
    expect(ac.resumed).toBe(1);
    ac.state = 'running';
    sfx('coin');
    expect(ac.played).toBe(1);
    expect(ac.buffers).toBe(Object.keys(SFX_BANK).length); // served from the prewarmed cache
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  });
});
