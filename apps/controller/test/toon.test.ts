import { describe, expect, it } from 'vitest';
import { replyMsg, parseReply, isSelfieAvatar, SELFIE_MAX_BYTES } from '@cadabra/spec';
import { dataUrlBytes, faceCrop, parseHex, toonify } from '../src/toon';

const N = 256;
const make = (f: (x: number, y: number) => [number, number, number]) => {
  const a = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const [r, g, b] = f(x, y); const i = (y * N + x) * 4; a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255; }
  return a;
};
const px = (a: Uint8ClampedArray, x: number, y: number) => { const i = (y * N + x) * 4; return [a[i]!, a[i + 1]!, a[i + 2]!, a[i + 3]!]; };
const RING = '#e63946';

describe('toonify', () => {
  const gradient = make((x, y) => [x, y, 128]);
  const out = toonify(gradient, N, RING);

  it('is pure: same size, input untouched', () => {
    expect(out.length).toBe(gradient.length);
    expect(out).not.toBe(gradient);
    expect(px(gradient, 10, 10)).toEqual([10, 10, 128, 255]);
    expect(() => toonify(new Uint8ClampedArray(10), N, RING)).toThrow();
  });

  it('masks to a circle: corners transparent, center opaque', () => {
    for (const [x, y] of [[0, 0], [N - 1, 0], [0, N - 1], [N - 1, N - 1], [8, 8]]) expect(px(out, x!, y!)[3]).toBe(0);
    expect(px(out, N / 2, N / 2)[3]).toBe(255);
    // every pixel beyond the radius is invisible
    let leaked = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2) > N / 2 + 1 && px(out, x, y)[3] !== 0) leaked++;
    expect(leaked).toBe(0);
  });

  it('draws an opaque ring in the player color', () => {
    const [r, g, b] = parseHex(RING);
    // 4 px inside the outer edge, on the horizontal axis
    expect(px(out, 4, N / 2)).toEqual([r, g, b, 255]);
    expect(px(out, N - 5, N / 2)).toEqual([r, g, b, 255]);
    expect(px(out, N / 2, 4)).toEqual([r, g, b, 255]);
  });

  it('posterizes smooth areas to 6 levels per channel', () => {
    const levels = new Set<number>();
    for (let y = 70; y < 190; y++) for (let x = 70; x < 190; x++) levels.add(px(out, x, y)[0]!);
    expect(levels.size).toBeLessThanOrEqual(6);
    expect(levels.size).toBeGreaterThan(1);
    for (const v of levels) expect([0, 51, 102, 153, 204, 255]).toContain(v);
  });

  it('draws dark outlines along strong edges', () => {
    const edge = toonify(make((x) => (x < N / 2 ? [250, 250, 250] : [20, 20, 20])), N, RING);
    const flat = px(edge, 100, 128);
    const line = px(edge, N / 2, 128);
    expect(line[0]!).toBeLessThan(60);          // ink
    expect(flat[0]!).toBeGreaterThan(200);      // untouched bright side
  });

  it('is deterministic and fast enough for a phone (256px)', () => {
    const t = performance.now();
    const again = toonify(gradient, N, RING);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(Buffer.compare(Buffer.from(again), Buffer.from(out))).toBe(0);
  });
});

describe('faceCrop', () => {
  it('stays inside the photo for portrait, landscape and tiny images', () => {
    for (const [w, h] of [[3024, 4032], [4032, 3024], [100, 100], [64, 1000], [1000, 64], [1, 1]] as const) {
      const { sx, sy, s } = faceCrop(w, h);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(sx).toBeGreaterThanOrEqual(0); expect(sy).toBeGreaterThanOrEqual(0);
      expect(sx + s).toBeLessThanOrEqual(w); expect(sy + s).toBeLessThanOrEqual(h);
    }
  });
});

describe('selfie avatar reply', () => {
  const url = (bytes: number, mime = 'webp') => `data:image/${mime};base64,${Buffer.alloc(bytes, 7).toString('base64')}`;
  it('accepts a <= 40 KB webp/jpeg data url and round-trips to the TV', () => {
    const u = url(25_000);
    expect(dataUrlBytes(u)).toBe(25_000);
    const msg = replyMsg({ reply: 'avatar.pick', avatar: u });
    expect(parseReply(msg)).toEqual({ reply: 'avatar.pick', avatar: u });
    expect(isSelfieAvatar(url(25_000, 'jpeg'))).toBe(true);
  });
  it('rejects oversize, other mimes and junk; premade keys still work', () => {
    expect(() => replyMsg({ reply: 'avatar.pick', avatar: url(SELFIE_MAX_BYTES + 2000) })).toThrow();
    expect(() => replyMsg({ reply: 'avatar.pick', avatar: url(1000, 'svg+xml') })).toThrow();
    expect(() => replyMsg({ reply: 'avatar.pick', avatar: 'data:image/webp;base64,<script>' })).toThrow();
    expect(parseReply(replyMsg({ reply: 'avatar.pick', avatar: 'fox' }))).toEqual({ reply: 'avatar.pick', avatar: 'fox' });
  });
});
