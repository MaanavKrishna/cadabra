import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePhoto, encodeAvatar, DECODE_MAX_SIDE } from '../src/toon';

const bm = (w: number, h: number) => ({ width: w, height: h, close: vi.fn() });
const file = new Blob([new Uint8Array(10)], { type: 'image/jpeg' });

function stubImage(dims: { w: number; h: number } | 'error', decode?: () => Promise<void>) {
  class FakeImage {
    naturalWidth = 0; naturalHeight = 0; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    decode = decode;
    set src(_v: string) {
      queueMicrotask(() => {
        if (dims === 'error') { this.onerror?.(); return; }
        this.naturalWidth = dims.w; this.naturalHeight = dims.h; this.onload?.();
      });
    }
  }
  vi.stubGlobal('Image', FakeImage);
}
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('decodePhoto', () => {
  it('falls back: EXIF-aware bitmap throws TypeError, plain bitmap succeeds', async () => {
    stubImage({ w: 800, h: 600 });
    const calls: any[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async (_f: Blob, o: any) => {
      calls.push(o);
      if (o?.imageOrientation) throw new TypeError('unsupported option');
      return bm(800, 600);
    }));
    const d = await decodePhoto(file);
    expect(calls).toHaveLength(2);
    expect(calls[0].imageOrientation).toBe('from-image');
    expect(calls[1].imageOrientation).toBeUndefined();
    expect(d.w).toBe(800);
  });

  it('falls back to <img>.decode() when every createImageBitmap variant fails', async () => {
    stubImage({ w: 640, h: 480 }, async () => {});
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new TypeError('nope'); }));
    const d = await decodePhoto(file);
    expect([d.w, d.h]).toEqual([640, 480]);
  });

  it('rejects (-> unreadable) when nothing can decode it', async () => {
    stubImage('error', async () => { throw new Error('bad'); });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new TypeError('nope'); }));
    await expect(decodePhoto(file)).rejects.toThrow();
  });

  it('asks the decoder to resize large photos to <= 1024 px, keeping aspect ratio', async () => {
    stubImage({ w: 4032, h: 3024 });
    const create = vi.fn(async (_f: Blob, o: any) => bm(o.resizeWidth, o.resizeHeight));
    vi.stubGlobal('createImageBitmap', create);
    await decodePhoto(file);
    const o = create.mock.calls[0]![1] as any;
    expect(o.resizeWidth).toBe(DECODE_MAX_SIDE);
    expect(o.resizeHeight).toBe(768);
    expect(o.resizeQuality).toBe('medium');
    expect(o.imageOrientation).toBe('from-image');
  });

  it('does not resize small photos', async () => {
    stubImage({ w: 600, h: 800 });
    const create = vi.fn(async (_f: Blob, _o?: any) => bm(600, 800));
    vi.stubGlobal('createImageBitmap', create);
    await decodePhoto(file);
    expect((create.mock.calls[0]![1] as any).resizeWidth).toBeUndefined();
  });
});

describe('encodeAvatar', () => {
  /** Fake canvases: webp size scales with quality; types are controllable. */
  function fakeCanvases(opts: { webp: boolean; jpegBytes?: (q: number) => number }) {
    const fills: string[] = [];
    const qs: { type: string; q: number; size: number }[] = [];
    const mk = (size: number) => ({
      width: size, height: size,
      getContext: () => ({ drawImage() {}, fillRect() {}, set fillStyle(v: string) { fills.push(v); } }),
      toBlob(this: { width: number }, cb: (b: Blob | null) => void, type: string, q: number) {
        let bytes: number; let t = type;
        if (type === 'image/webp') { bytes = Math.round(q * 40_000); if (!opts.webp) t = 'image/png'; }
        else bytes = opts.jpegBytes ? opts.jpegBytes(q) : 12_000;
        qs.push({ type: t, q, size: this.width });
        cb(new Blob([new Uint8Array(bytes)], { type: t }));
      },
    });
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => (tag === 'canvas' ? mk(0) : null)) as any);
    return { src: mk(256) as unknown as HTMLCanvasElement, fills, qs };
  }

  it('walks quality down until the WebP is <= 25 KB', async () => {
    const { src, qs } = fakeCanvases({ webp: true });
    const r = await encodeAvatar(src);
    expect(r?.mime).toBe('image/webp');
    expect(qs.map((x) => x.q)).toEqual([0.85, 0.7, 0.55]); // 34000, 28000, 22000 bytes
    const bytes = Math.floor(((r!.dataUrl.length - r!.dataUrl.indexOf(',') - 1) * 3) / 4);
    expect(bytes).toBeLessThanOrEqual(25_000);
  });

  it('falls back to a square JPEG on a ring-colored field when WebP encoding is unsupported', async () => {
    const { src, fills, qs } = fakeCanvases({ webp: false });
    const r = await encodeAvatar(src, '#e63946');
    expect(r?.mime).toBe('image/jpeg');
    expect(fills).toContain('#e63946');
    expect(qs.some((x) => x.type === 'image/jpeg')).toBe(true);
  });

  it('shrinks the canvas when even the lowest quality is too big, then gives up with undefined', async () => {
    const { src, qs } = fakeCanvases({ webp: false, jpegBytes: () => 90_000 });
    expect(await encodeAvatar(src)).toBeUndefined();
    expect(new Set(qs.map((x) => x.size))).toEqual(new Set([256, 192, 160]));
  });
});
