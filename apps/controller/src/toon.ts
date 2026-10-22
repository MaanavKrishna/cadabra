// On-device "toon" selfie filter. Pure functions over raw RGBA arrays (testable without a canvas);
// the canvas/File glue is at the bottom. The photo never leaves the phone: only the stylized,
// circular avatar (<= 25 KB) is sent to the TV.
import { SELFIE_MAX_BYTES } from '@cadabra/spec';

export const TOON_SIZE = 256;
export const TOON_TARGET_BYTES = 25_000;
const LEVELS = 6;
const DARK: [number, number, number] = [28, 18, 40];

export function parseHex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return [255, 180, 0];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The square region of a w x h photo to use: ~85% of the short side, centered horizontally, biased up (faces sit high). */
export function faceCrop(w: number, h: number): { sx: number; sy: number; s: number } {
  const s = Math.max(1, Math.floor(Math.min(w, h) * 0.85));
  const sx = Math.floor((w - s) / 2);
  const sy = Math.min(Math.max(0, Math.floor(h * 0.42 - s / 2)), h - s);
  return { sx, sy, s };
}

/** 3 separable box-blur passes (radius r) over RGB, edge-clamped: a cheap Gaussian/bilateral-ish smoother. */
function blurRgb(src: Float32Array, n: number, r: number, passes: number): Float32Array {
  const a = Float32Array.from(src);
  const b = new Float32Array(src.length);
  const win = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < n; y++) {            // horizontal
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += a[(y * n + Math.min(n - 1, Math.max(0, k))) * 3 + c]!;
        for (let x = 0; x < n; x++) {
          b[(y * n + x) * 3 + c] = sum / win;
          sum += a[(y * n + Math.min(n - 1, x + r + 1)) * 3 + c]! - a[(y * n + Math.max(0, x - r)) * 3 + c]!;
        }
      }
    }
    for (let x = 0; x < n; x++) {            // vertical
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += b[(Math.min(n - 1, Math.max(0, k)) * n + x) * 3 + c]!;
        for (let y = 0; y < n; y++) {
          a[(y * n + x) * 3 + c] = sum / win;
          sum += b[(Math.min(n - 1, y + r + 1) * n + x) * 3 + c]! - b[(Math.max(0, y - r) * n + x) * 3 + c]!;
        }
      }
    }
  }
  return a;
}

/**
 * Cartoonize an n x n RGBA image into a circular avatar, in place of a copy:
 * smooth -> saturation boost -> posterize (6 levels) -> Sobel outlines -> circular mask with a colored ring.
 * Pixels outside the circle are fully transparent; the ring is opaque. Returns a new array.
 */
export function toonify(rgba: Uint8ClampedArray, n: number, ringColor: string): Uint8ClampedArray {
  if (rgba.length !== n * n * 4) throw new Error('toonify: bad buffer size');
  const rgb = new Float32Array(n * n * 3);
  for (let i = 0; i < n * n; i++) { rgb[i * 3] = rgba[i * 4]!; rgb[i * 3 + 1] = rgba[i * 4 + 1]!; rgb[i * 3 + 2] = rgba[i * 4 + 2]!; }
  const sm = blurRgb(rgb, n, 2, 3);

  // luminance of the smoothed image for edge detection
  const lum = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) lum[i] = 0.299 * sm[i * 3]! + 0.587 * sm[i * 3 + 1]! + 0.114 * sm[i * 3 + 2]!;
  const at = (x: number, y: number) => lum[Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))]!;

  const out = new Uint8ClampedArray(n * n * 4);
  const ring = parseHex(ringColor);
  const R = n / 2;
  const ringW = Math.max(3, Math.round(n * 0.07));
  const inner = R - ringW;
  const step = 255 / (LEVELS - 1);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const d = Math.hypot(x + 0.5 - R, y + 0.5 - R);
      const cover = Math.min(1, Math.max(0, R - d + 0.5)); // 1px antialiased outer edge
      if (cover <= 0) continue;
      let rgbOut: [number, number, number];
      if (d >= inner) {
        rgbOut = ring;
      } else {
        const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
        const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
        const edge = Math.min(1, Math.max(0, (Math.hypot(gx, gy) - 55) / 70));
        const g = lum[i]!;
        const px: number[] = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          let v = g + (sm[i * 3 + c]! - g) * 1.35;                     // saturation boost
          v = Math.round(Math.min(255, Math.max(0, v)) / step) * step;   // posterize
          px[c] = v * (1 - edge) + DARK[c]! * edge;                      // ink outline
        }
        rgbOut = [px[0]!, px[1]!, px[2]!];
        // thin dark line between face and ring so the ring reads cleanly
        const t = Math.min(1, Math.max(0, d - (inner - 2)) / 2);
        if (t > 0) for (let c = 0; c < 3; c++) rgbOut[c] = rgbOut[c]! * (1 - t) + DARK[c]! * t;
      }
      out[i * 4] = rgbOut[0]; out[i * 4 + 1] = rgbOut[1]; out[i * 4 + 2] = rgbOut[2];
      out[i * 4 + 3] = Math.round(cover * 255);
    }
  }
  return out;
}

// ---- canvas / File glue (browser only) ----

export type ToonResult =
  | { ok: true; dataUrl: string; bytes: number; mime: string }
  | { ok: false; reason: 'no-file' | 'unreadable' | 'too-big' };

/** data:URL payload bytes (base64-decoded size). */
export const dataUrlBytes = (u: string): number => {
  const b64 = u.slice(u.indexOf(',') + 1);
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
};

const toBlob = (c: HTMLCanvasElement, type: string, q: number) =>
  new Promise<Blob | null>((res) => c.toBlob(res, type, q));
const blobUrl = (b: Blob) => new Promise<string>((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result));
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(b);
});

/** Encode the circular avatar: WebP (keeps the transparent corners) shrinking quality, then JPEG on a dark backdrop. */
export async function encodeAvatar(src: HTMLCanvasElement): Promise<{ dataUrl: string; mime: string } | undefined> {
  for (const size of [src.width, 192, 160]) {
    const c = size === src.width ? src : scaled(src, size);
    for (const q of [0.85, 0.7, 0.55, 0.4]) {
      const b = await toBlob(c, 'image/webp', q);
      if (b && b.type === 'image/webp' && b.size <= TOON_TARGET_BYTES) return { dataUrl: await blobUrl(b), mime: b.type };
    }
    const flat = document.createElement('canvas');
    flat.width = flat.height = c.width;
    const g = flat.getContext('2d');
    if (!g) return undefined;
    g.fillStyle = '#1c1228';
    g.fillRect(0, 0, flat.width, flat.height);
    g.drawImage(c, 0, 0);
    for (const q of [0.85, 0.7, 0.55, 0.4]) {
      const b = await toBlob(flat, 'image/jpeg', q);
      if (b && b.size <= TOON_TARGET_BYTES) return { dataUrl: await blobUrl(b), mime: b.type };
    }
  }
  return undefined;
}

function scaled(src: HTMLCanvasElement, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d')!.drawImage(src, 0, 0, size, size);
  return c;
}

async function decode(file: Blob): Promise<{ img: CanvasImageSource; w: number; h: number; free(): void }> {
  if (typeof createImageBitmap === 'function') {
    const bm = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    return { img: bm, w: bm.width, h: bm.height, free: () => bm.close() };
  }
  const url = URL.createObjectURL(file);
  const el = new Image();
  await new Promise<void>((res, rej) => { el.onload = () => res(); el.onerror = () => rej(new Error('decode')); el.src = url; });
  return { img: el, w: el.naturalWidth, h: el.naturalHeight, free: () => URL.revokeObjectURL(url) };
}

/** Photo File -> circular cartoon avatar data URL (<= 25 KB). All on-device; the source image is dropped afterwards. */
export async function selfieToToon(file: File | Blob | undefined | null, ringColor: string): Promise<ToonResult> {
  if (!file || !file.size) return { ok: false, reason: 'no-file' };
  let dec: Awaited<ReturnType<typeof decode>> | undefined;
  const work = document.createElement('canvas');
  try {
    dec = await decode(file);
    const { sx, sy, s } = faceCrop(dec.w, dec.h);
    work.width = work.height = TOON_SIZE;
    const g = work.getContext('2d', { willReadFrequently: true });
    if (!g) return { ok: false, reason: 'unreadable' };
    g.imageSmoothingQuality = 'high';
    g.drawImage(dec.img, sx, sy, s, s, 0, 0, TOON_SIZE, TOON_SIZE);
    const px = g.getImageData(0, 0, TOON_SIZE, TOON_SIZE);
    const out = toonify(px.data, TOON_SIZE, ringColor);
    g.clearRect(0, 0, TOON_SIZE, TOON_SIZE);
    g.putImageData(new ImageData(out as Uint8ClampedArray<ArrayBuffer>, TOON_SIZE, TOON_SIZE), 0, 0);
    const enc = await encodeAvatar(work);
    if (!enc || dataUrlBytes(enc.dataUrl) > SELFIE_MAX_BYTES) return { ok: false, reason: 'too-big' };
    return { ok: true, dataUrl: enc.dataUrl, bytes: dataUrlBytes(enc.dataUrl), mime: enc.mime };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    dec?.free();
    work.width = work.height = 0; // drop the pixels
  }
}
