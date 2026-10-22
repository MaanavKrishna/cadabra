import { describe, expect, test } from 'vitest';
import { VoiceQueue, captionMs, type VoiceDeps } from '../src/host/voice';

function deps(over: Partial<VoiceDeps> = {}) {
  const log: string[] = [];
  const plays: { url: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  const d: VoiceDeps = {
    play: (url) => new Promise<void>((resolve, reject) => { log.push(`play ${url}`); plays.push({ url, resolve, reject }); }),
    caption: (t) => log.push(t === null ? 'caption -' : `caption ${t}`),
    duck: (on) => log.push(`duck ${on}`),
    voiceOn: () => true,
    wait: (ms) => { log.push(`wait ${ms}`); return Promise.resolve(); },
    ...over,
  };
  return { d, log, plays };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('host voice queue', () => {
  test('plays lines one at a time, captioned, ducking sfx while speaking', async () => {
    const { d, log, plays } = deps();
    const q = new VoiceQueue(d);
    q.say({ text: 'Hello room', url: 'https://cdn/a.mp3' });
    q.say({ text: 'Second', url: 'https://cdn/b.mp3' });
    await flush();
    expect(plays.map((p) => p.url)).toEqual(['https://cdn/a.mp3']); // b waits its turn
    expect(log.slice(0, 3)).toEqual(['caption Hello room', 'duck true', 'play https://cdn/a.mp3']);
    plays[0]!.resolve();
    await flush(); await flush();
    expect(log).toContain('duck false');
    expect(plays.map((p) => p.url)).toEqual(['https://cdn/a.mp3', 'https://cdn/b.mp3']);
    plays[1]!.resolve();
    await q.idle();
    expect(log[log.length - 1]).toBe('caption -');
    expect(log.filter((l) => l === 'duck true')).toHaveLength(2);
  });

  test('captions still show with voice off, no url, or failed audio', async () => {
    const off = deps({ voiceOn: () => false });
    const q1 = new VoiceQueue(off.d);
    q1.say({ text: 'Quiet line', url: 'https://cdn/a.mp3' });
    await q1.idle();
    expect(off.plays).toHaveLength(0);
    expect(off.log).toContain('caption Quiet line');
    expect(off.log).toContain(`wait ${captionMs('Quiet line')}`);

    const noUrl = deps();
    const q2 = new VoiceQueue(noUrl.d);
    q2.say({ text: 'No audio here' });
    await q2.idle();
    expect(noUrl.plays).toHaveLength(0);
    expect(noUrl.log).toContain('caption No audio here');

    const fail = deps({ play: () => Promise.reject(new Error('404')) });
    const q3 = new VoiceQueue(fail.d);
    q3.say({ text: 'Broken audio', url: 'https://cdn/x.mp3' });
    q3.say({ text: 'Next one' });
    await q3.idle();
    expect(fail.log).toContain('caption Broken audio');
    expect(fail.log).toContain('caption Next one');
    expect(fail.log.filter((l) => l.startsWith('duck'))).toEqual(['duck true', 'duck false']);
  });

  test('caption time scales with text length within bounds', () => {
    expect(captionMs('Hi')).toBeGreaterThanOrEqual(2000);
    expect(captionMs('x'.repeat(1000))).toBeLessThanOrEqual(8000);
    expect(captionMs('a'.repeat(100))).toBeGreaterThan(captionMs('a'.repeat(20)));
  });
});
