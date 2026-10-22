// Tiny dependency-free indexed PNG encoder (4-bit palette, stored deflate).
// Output size depends only on dimensions, so a 320x320 doodle is always ~69 KB as a dataURL.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]!) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let o = 0;
  out[o++] = 0x78; out[o++] = 0x01;
  for (let b = 0; b < blocks; b++) {
    const s = b * 65535, len = Math.min(65535, raw.length - s);
    out[o++] = b === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff; out[o++] = len >>> 8;
    out[o++] = ~len & 0xff; out[o++] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(s, s + len), o); o += len;
  }
  const ad = adler32(raw);
  out[o++] = ad >>> 24; out[o++] = (ad >>> 16) & 0xff; out[o++] = (ad >>> 8) & 0xff; out[o++] = ad & 0xff;
  return out;
}

const hexRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.replace('#', '').slice(0, 6), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

/**
 * Encode `w*h` palette indices (0 = transparent, 1..15 = palette[i-1]) as a PNG dataURL.
 */
export function encodeIndexedPng(w: number, h: number, pixels: Uint8Array, palette: string[]): string {
  if (palette.length > 15) throw new Error('palette max 15 colors');
  const rowBytes = Math.ceil(w / 2);
  const raw = new Uint8Array(h * (rowBytes + 1));
  for (let y = 0; y < h; y++) {
    const r = y * (rowBytes + 1);
    raw[r] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const v = pixels[y * w + x]! & 0x0f;
      raw[r + 1 + (x >> 1)]! |= x & 1 ? v : v << 4;
    }
  }
  const colors = [[0, 0, 0] as [number, number, number], ...palette.map(hexRgb)];
  const plte = new Uint8Array(colors.length * 3);
  colors.forEach((c, i) => plte.set(c, i * 3));
  const trns = new Uint8Array(colors.length).fill(255); trns[0] = 0;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 4; ihdr[9] = 3; // bit depth 4, indexed color

  const chunks: [string, Uint8Array][] = [['IHDR', ihdr], ['PLTE', plte], ['tRNS', trns], ['IDAT', zlibStored(raw)], ['IEND', new Uint8Array(0)]];
  const total = 8 + chunks.reduce((s, [, d]) => s + 12 + d.length, 0);
  const png = new Uint8Array(total);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let o = 8;
  const pv = new DataView(png.buffer);
  for (const [type, data] of chunks) {
    pv.setUint32(o, data.length);
    for (let i = 0; i < 4; i++) png[o + 4 + i] = type.charCodeAt(i);
    png.set(data, o + 8);
    pv.setUint32(o + 8 + data.length, crc32(png, o + 4, o + 8 + data.length));
    o += 12 + data.length;
  }
  let bin = '';
  for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}
