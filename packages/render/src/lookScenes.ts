/**
 * Arena backgrounds for the toybox, cosmos and retro looks (round R2). Like the neon arena,
 * each is drawn ONCE with Canvas 2D and handed to the background bake as one opaque sprite:
 * soft shadows, glows, stars and scanlines are baked pixels, never per-frame filters.
 */
import { Container, Sprite, Texture } from 'pixi.js';
import type { Rect } from './scenery';
import type { LookId } from './looks';
import { LOOKS } from './looks';
import { darken, lighten, mix, type Palette } from './theme';
import { css } from './lookArt';
import { drawNeonArena } from './neonScene';

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Small deterministic PRNG so every bake of a scene is identical. */
function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function base(W: number, H: number, pad: number): { cv: HTMLCanvasElement; g: CanvasRenderingContext2D; FW: number; FH: number } {
  const FW = Math.ceil(W + pad * 2), FH = Math.ceil(H + pad * 2);
  const cv = document.createElement('canvas');
  cv.width = FW;
  cv.height = FH;
  const g = cv.getContext('2d')!;
  g.translate(pad, pad);
  return { cv, g, FW, FH };
}

// ================================================================== toybox

/**
 * A toy arena on a play table: periwinkle surround with soft polka dots, the arena lifted on a
 * soft drop shadow, a glossy kerb rail in alternating candy and white segments, and a clean
 * light floor with moulded panel seams and soft court markings.
 */
export function drawToyArena(r: Rect, W: number, H: number, pad: number, _p: Palette, arenaKind?: string): HTMLCanvasElement {
  const { cv, g, FW, FH } = base(W, H, pad);
  const s = H / 720;
  const L = LOOKS.toybox.c;

  // ---- surround ----
  const sky = g.createRadialGradient(W / 2, H * 0.42, H * 0.1, W / 2, H / 2, W * 0.75);
  sky.addColorStop(0, '#8db8ff');
  sky.addColorStop(0.55, '#5a8cf5');
  sky.addColorStop(1, '#3256c9');
  g.fillStyle = sky;
  g.fillRect(-pad, -pad, FW, FH);
  // soft polka dots in a staggered grid
  const step = 64 * s;
  for (let row = 0, y = -pad; y < H + pad; y += step, row++) {
    for (let x = -pad + (row % 2 ? step / 2 : 0); x < W + pad; x += step) {
      g.beginPath();
      g.arc(x, y, 9 * s, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,255,255,0.09)';
      g.fill();
    }
  }

  const rad = Math.round(Math.min(r.w, r.h) * 0.06);
  const rail = Math.max(14, 20 * s);
  const ox = r.x - rail, oy = r.y - rail, ow = r.w + rail * 2, oh = r.h + rail * 2, orad = rad + rail;

  // ---- drop shadow under the whole table ----
  g.save();
  g.shadowColor = 'rgba(16,20,70,0.45)';
  g.shadowBlur = 46 * s;
  g.shadowOffsetY = 22 * s;
  rr(g, ox, oy, ow, oh, orad);
  g.fillStyle = '#2b3fa8';
  g.fill();
  g.restore();

  // ---- the kerb rail: candy segments under a gloss ----
  g.save();
  rr(g, ox, oy, ow, oh, orad);
  g.clip();
  const seg = 46 * s;
  const cx = W / 2, cy = H / 2;
  const n = Math.ceil(((ow + oh) * 2) / seg);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, W + H, a0, a1);
    g.closePath();
    g.fillStyle = i % 2 === 0 ? css(L.magenta) : '#ffffff';
    g.fill();
  }
  // round the kerb: lit top, shaded bottom
  const kg = g.createLinearGradient(0, oy, 0, oy + oh);
  kg.addColorStop(0, 'rgba(255,255,255,0.35)');
  kg.addColorStop(0.5, 'rgba(255,255,255,0)');
  kg.addColorStop(1, 'rgba(40,20,80,0.22)');
  g.fillStyle = kg;
  g.fillRect(ox, oy, ow, oh);
  g.restore();
  // rail outline and its specular line
  rr(g, ox, oy, ow, oh, orad);
  g.strokeStyle = css(darken(L.magenta, 0.45), 0.6);
  g.lineWidth = 2.5 * s;
  g.stroke();
  rr(g, ox + rail * 0.3, oy + rail * 0.22, ow - rail * 0.6, oh - rail * 0.44, orad - rail * 0.3);
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 2.5 * s;
  g.stroke();

  // ---- the floor ----
  rr(g, r.x, r.y, r.w, r.h, rad);
  const fl = g.createLinearGradient(0, r.y, 0, r.y + r.h);
  fl.addColorStop(0, '#fbfaff');
  fl.addColorStop(1, '#ebe8f6');
  g.fillStyle = fl;
  g.fill();
  g.save();
  rr(g, r.x, r.y, r.w, r.h, rad);
  g.clip();
  if (arenaKind === 'lanes') {
    // alternating light lanes are drawn by the lane renderer; give it a soft stripe base
    for (let i = 0; i < 8; i++) {
      if (i % 2) continue;
      g.fillStyle = 'rgba(120,110,190,0.05)';
      g.fillRect(r.x, r.y + (r.h * i) / 8, r.w, r.h / 8);
    }
  } else {
    // moulded panels: a seam (dark line + light line under it) every cell
    const cell = Math.max(40, Math.round(r.w / 12));
    for (let x = r.x + ((r.w / 2) % cell); x < r.x + r.w; x += cell) {
      g.fillStyle = 'rgba(110,100,170,0.13)';
      g.fillRect(Math.round(x) - 1, r.y, 2, r.h);
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.fillRect(Math.round(x) + 1, r.y, 1.5, r.h);
    }
    for (let y = r.y + ((r.h / 2) % cell); y < r.y + r.h; y += cell) {
      g.fillStyle = 'rgba(110,100,170,0.13)';
      g.fillRect(r.x, Math.round(y) - 1, r.w, 2);
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.fillRect(r.x, Math.round(y) + 1, r.w, 1.5);
    }
    // soft court markings: centre circle and halfway line
    g.strokeStyle = css(L.cyan, 0.2);
    g.lineWidth = 6 * s;
    g.beginPath();
    g.arc(r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) * 0.16, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.moveTo(r.x + r.w / 2, r.y);
    g.lineTo(r.x + r.w / 2, r.y + r.h);
    g.stroke();
  }
  // ambient occlusion along the rail
  const ao = 26 * s;
  const sides: [number, number, number, number, number, number, number, number][] = [
    [r.x, r.y, r.w, ao, 0, r.y, 0, r.y + ao],
    [r.x, r.y + r.h - ao, r.w, ao, 0, r.y + r.h, 0, r.y + r.h - ao],
    [r.x, r.y, ao, r.h, r.x, 0, r.x + ao, 0],
    [r.x + r.w - ao, r.y, ao, r.h, r.x + r.w, 0, r.x + r.w - ao, 0],
  ];
  for (const [x, y, w, h, x0, y0, x1, y1] of sides) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, 'rgba(60,40,120,0.2)');
    gr.addColorStop(1, 'rgba(60,40,120,0)');
    g.fillStyle = gr;
    g.fillRect(x, y, w, h);
  }
  g.restore();
  rr(g, r.x, r.y, r.w, r.h, rad);
  g.strokeStyle = 'rgba(60,40,120,0.25)';
  g.lineWidth = 2 * s;
  g.stroke();
  return cv;
}

// ================================================================== cosmos

function starfield(g: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, s: number, rnd: () => number): void {
  // far dust, mid stars, a few bright ones with a flare: three depths baked into one layer
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(200,210,255,${0.12 + rnd() * 0.35})`;
    g.fillRect(x0 + rnd() * w, y0 + rnd() * h, s, s);
  }
  const tints = [0xffffff, 0xbfe9ff, 0xffe2c4, 0xe3c8ff];
  for (let i = 0; i < 150; i++) {
    const x = x0 + rnd() * w, y = y0 + rnd() * h, r = (0.8 + rnd() * 1.1) * s;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = css(tints[i % 4]!, 0.55 + rnd() * 0.4);
    g.fill();
  }
  for (let i = 0; i < 16; i++) {
    const x = x0 + rnd() * w, y = y0 + rnd() * h, r = (1.6 + rnd() * 1.2) * s;
    const gr = g.createRadialGradient(x, y, 0, x, y, r * 6);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)');
    gr.addColorStop(0.2, 'rgba(190,220,255,0.35)');
    gr.addColorStop(1, 'rgba(190,220,255,0)');
    g.fillStyle = gr;
    g.fillRect(x - r * 6, y - r * 6, r * 12, r * 12);
    g.fillStyle = 'rgba(220,235,255,0.6)';
    g.fillRect(x - r * 5, y - 0.5 * s, r * 10, s);
    g.fillRect(x - 0.5 * s, y - r * 5, s, r * 10);
  }
}

function planet(g: CanvasRenderingContext2D, x: number, y: number, R: number, c0: number, c1: number, ring: boolean): void {
  if (ring) {
    // back half of the ring
    g.save();
    g.translate(x, y);
    g.rotate(-0.38);
    g.beginPath();
    g.ellipse(0, 0, R * 1.9, R * 0.42, 0, Math.PI, Math.PI * 2);
    g.strokeStyle = 'rgba(230,200,255,0.35)';
    g.lineWidth = R * 0.16;
    g.stroke();
    g.restore();
  }
  g.save();
  g.beginPath();
  g.arc(x, y, R, 0, Math.PI * 2);
  g.clip();
  const gr = g.createLinearGradient(x - R, y - R, x + R, y + R);
  gr.addColorStop(0, css(c0));
  gr.addColorStop(1, css(c1));
  g.fillStyle = gr;
  g.fillRect(x - R, y - R, R * 2, R * 2);
  // bands
  for (let i = -5; i <= 5; i++) {
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';
    g.save();
    g.translate(x, y);
    g.rotate(-0.38);
    g.fillRect(-R, i * R * 0.17, R * 2, R * 0.1);
    g.restore();
  }
  // terminator: the night side
  const sh = g.createRadialGradient(x - R * 0.45, y - R * 0.45, R * 0.2, x, y, R * 1.25);
  sh.addColorStop(0, 'rgba(0,0,0,0)');
  sh.addColorStop(0.65, 'rgba(3,5,18,0.35)');
  sh.addColorStop(1, 'rgba(3,5,18,0.92)');
  g.fillStyle = sh;
  g.fillRect(x - R, y - R, R * 2, R * 2);
  g.restore();
  // atmosphere rim
  g.beginPath();
  g.arc(x, y, R, Math.PI * 0.9, Math.PI * 1.75);
  g.strokeStyle = css(lighten(c0, 0.4), 0.55);
  g.lineWidth = R * 0.04;
  g.stroke();
  if (ring) {
    g.save();
    g.translate(x, y);
    g.rotate(-0.38);
    g.beginPath();
    g.ellipse(0, 0, R * 1.9, R * 0.42, 0, 0, Math.PI);
    g.strokeStyle = 'rgba(240,215,255,0.6)';
    g.lineWidth = R * 0.16;
    g.stroke();
    g.beginPath();
    g.ellipse(0, 0, R * 1.62, R * 0.34, 0, 0, Math.PI);
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = R * 0.04;
    g.stroke();
    g.restore();
  }
}

/**
 * A deck floating in deep space: nebula wash and a baked three-depth starfield, a ringed gas
 * giant and a moon in the margins, a dark glass deck with a faint radar grid, and a glowing
 * edge that runs cyan to violet with beacon lights on the corners.
 */
export function drawCosmosArena(r: Rect, W: number, H: number, pad: number, p: Palette, arenaKind?: string): HTMLCanvasElement {
  const { cv, g, FW, FH } = base(W, H, pad);
  const s = H / 720;
  const L = LOOKS.cosmos.c;
  const rnd = prng(0xc05305);
  g.fillStyle = '#04061a';
  g.fillRect(-pad, -pad, FW, FH);
  // nebula: overlapping soft clouds, additive
  g.save();
  g.globalCompositeOperation = 'lighter';
  const clouds: [number, number, number, number, number][] = [
    [0.18, 0.25, 0.55, L.magenta, 0.22], [0.82, 0.78, 0.6, 0x2b7bff, 0.2], [0.65, 0.18, 0.4, 0x2bd4ff, 0.12],
    [0.3, 0.85, 0.45, 0x7a3dff, 0.18], [0.5, 0.5, 0.7, 0x1a2a6c, 0.25],
  ];
  for (const [fx, fy, fr, c, a] of clouds) {
    const x = fx * W, y = fy * H, R = fr * W;
    const gr = g.createRadialGradient(x, y, 0, x, y, R);
    gr.addColorStop(0, css(c, a));
    gr.addColorStop(0.5, css(c, a * 0.4));
    gr.addColorStop(1, css(c, 0));
    g.fillStyle = gr;
    g.fillRect(x - R, y - R, R * 2, R * 2);
  }
  // wispy filaments
  for (let i = 0; i < 40; i++) {
    const x = rnd() * W, y = rnd() * H;
    g.beginPath();
    g.ellipse(x, y, (60 + rnd() * 160) * s, (6 + rnd() * 14) * s, -0.5 + rnd() * 0.4, 0, Math.PI * 2);
    g.fillStyle = css(i % 2 ? L.magenta : L.cyan, 0.025);
    g.fill();
  }
  g.restore();
  starfield(g, -pad, -pad, FW, FH, s, rnd);
  // planets in the margins (the deck covers whatever overlaps)
  planet(g, W - 120 * s, 70 * s, 120 * s, 0xd59cff, 0x5a3db8, true);
  planet(g, 96 * s, H - 60 * s, 46 * s, 0x9fe8ff, 0x2e5a8c, false);

  // ---- the deck ----
  const rad = Math.round(Math.min(r.w, r.h) * 0.05);
  const glowW = (x0: number, x1: number) => {
    const gr = g.createLinearGradient(x0, 0, x1, 0);
    gr.addColorStop(0, css(L.cyan));
    gr.addColorStop(0.5, css(mix(L.cyan, L.magenta, 0.5)));
    gr.addColorStop(1, css(L.magenta));
    return gr;
  };
  // outer halo (baked glow)
  g.save();
  rr(g, r.x, r.y, r.w, r.h, rad);
  g.shadowColor = css(mix(L.cyan, L.magenta, 0.4), 0.9);
  g.shadowBlur = 50 * s;
  g.strokeStyle = glowW(r.x, r.x + r.w);
  g.lineWidth = 6 * s;
  g.stroke();
  g.restore();
  rr(g, r.x, r.y, r.w, r.h, rad);
  const fl = g.createRadialGradient(r.x + r.w / 2, r.y + r.h * 0.4, 10, r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h) * 0.7);
  fl.addColorStop(0, 'rgba(26,36,86,0.86)');
  fl.addColorStop(1, 'rgba(8,11,34,0.94)');
  g.fillStyle = fl;
  g.fill();
  g.save();
  rr(g, r.x, r.y, r.w, r.h, rad);
  g.clip();
  const mx = r.x + r.w / 2, my = r.y + r.h / 2;
  if (arenaKind !== 'lanes') {
    // radar grid: rings and spokes from the centre
    for (let k = 1; k <= 9; k++) {
      g.beginPath();
      g.arc(mx, my, (Math.max(r.w, r.h) * k) / 14, 0, Math.PI * 2);
      g.strokeStyle = css(L.cyan, k % 3 === 0 ? 0.13 : 0.06);
      g.lineWidth = 1.5 * s;
      g.stroke();
    }
    for (let i = 0; i < 24; i++) {
      const a = (i * Math.PI) / 12;
      g.beginPath();
      g.moveTo(mx, my);
      g.lineTo(mx + Math.cos(a) * r.w, my + Math.sin(a) * r.w);
      g.strokeStyle = css(L.cyan, i % 6 === 0 ? 0.1 : 0.04);
      g.lineWidth = 1.2 * s;
      g.stroke();
    }
  }
  // glass sheen across the top of the deck
  const sh = g.createLinearGradient(r.x, r.y, r.x + r.w * 0.5, r.y + r.h * 0.6);
  sh.addColorStop(0, 'rgba(160,200,255,0.08)');
  sh.addColorStop(0.5, 'rgba(160,200,255,0)');
  g.fillStyle = sh;
  g.fillRect(r.x, r.y, r.w, r.h);
  g.restore();
  // crisp edge: gradient line + white-hot inner line
  rr(g, r.x, r.y, r.w, r.h, rad);
  g.strokeStyle = glowW(r.x, r.x + r.w);
  g.lineWidth = 3.5 * s;
  g.stroke();
  rr(g, r.x + 3 * s, r.y + 3 * s, r.w - 6 * s, r.h - 6 * s, rad - 3 * s);
  g.strokeStyle = 'rgba(230,240,255,0.35)';
  g.lineWidth = 1.2 * s;
  g.stroke();
  // corner beacons
  for (const [x, y, c] of [[r.x, r.y, L.cyan], [r.x + r.w, r.y, L.magenta], [r.x, r.y + r.h, L.cyan], [r.x + r.w, r.y + r.h, L.magenta]] as const) {
    const gr = g.createRadialGradient(x, y, 0, x, y, 26 * s);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.2, css(c, 0.6));
    gr.addColorStop(1, css(c, 0));
    g.fillStyle = gr;
    g.fillRect(x - 26 * s, y - 26 * s, 52 * s, 52 * s);
  }
  void p;
  return cv;
}

// ================================================================== retro

/**
 * A pixel arena drawn at 1/q resolution (q = 8 at 1080p, 5 at 720p: the same pixel size as the sprites) and scaled up with
 * nearest filtering, so every pixel is a crisp q x q block. Starry surround with a dither
 * ramp, a two-tone bezel with corner blocks, a black floor with a dotted grid. Scanlines are
 * baked at full resolution on the dark bottom row of each pixel (background only).
 */
export function drawRetroArena(r: Rect, W: number, H: number, pad: number, _p: Palette, arenaKind?: string): HTMLCanvasElement {
  const { cv, g, FW, FH } = base(W, H, pad);
  const q = Math.max(3, Math.round(H / 135));
  const lw = Math.ceil(FW / q), lh = Math.ceil(FH / q);
  const lo = document.createElement('canvas');
  lo.width = lw;
  lo.height = lh;
  const d = lo.getContext('2d')!;
  const P = { navy: '#1d2b53', purple: '#7e2553', dkgrey: '#5f574f', blue: '#29adff', pink: '#ff77a8', white: '#fff1e8', black: '#000000', dkblue: '#0f1736' };
  const rnd = prng(0x8b17);
  // surround: navy with a dither ramp toward the bottom and pixel stars
  d.fillStyle = P.dkblue;
  d.fillRect(0, 0, lw, lh);
  for (let y = 0; y < lh; y++) {
    const k = y / lh;
    for (let x = 0; x < lw; x++) {
      const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]][y % 4]![x % 4]! / 16;
      if (k * 0.9 > bayer + 0.25) {
        d.fillStyle = P.navy;
        d.fillRect(x, y, 1, 1);
      }
    }
  }
  for (let i = 0; i < 90; i++) {
    d.fillStyle = i % 7 === 0 ? P.white : i % 3 === 0 ? P.blue : P.dkgrey;
    d.fillRect(Math.floor(rnd() * lw), Math.floor(rnd() * lh), 1, 1);
  }
  // arena in low-res coords (pad offset included)
  const ax = Math.round((r.x + pad) / q), ay = Math.round((r.y + pad) / q);
  const aw = Math.round(r.w / q), ah = Math.round(r.h / q);
  // bezel: purple outer band, pink line, white inner line (1 low-res px each)
  d.fillStyle = P.purple;
  d.fillRect(ax - 3, ay - 3, aw + 6, ah + 6);
  d.fillStyle = P.pink;
  d.fillRect(ax - 2, ay - 2, aw + 4, ah + 4);
  d.fillStyle = P.white;
  d.fillRect(ax - 1, ay - 1, aw + 2, ah + 2);
  // floor: black with a dotted grid, every 4th dot blue
  d.fillStyle = P.black;
  d.fillRect(ax, ay, aw, ah);
  if (arenaKind !== 'lanes') {
    for (let y = ay + 4; y < ay + ah; y += 8) for (let x = ax + 4; x < ax + aw; x += 8) {
      d.fillStyle = (x - ax - 4) % 32 === 0 && (y - ay - 4) % 32 === 0 ? P.blue : P.navy;
      d.fillRect(x, y, 1, 1);
    }
  }
  // corner blocks
  for (const [x, y] of [[ax - 4, ay - 4], [ax + aw + 1, ay - 4], [ax - 4, ay + ah + 1], [ax + aw + 1, ay + ah + 1]] as const) {
    d.fillStyle = P.white;
    d.fillRect(x, y, 3, 3);
    d.fillStyle = P.blue;
    d.fillRect(x + 1, y + 1, 1, 1);
  }
  // upscale: crisp pixels
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(lo, 0, 0, lw * q, lh * q);
  // scanlines on the bottom row of each pixel row, and a soft CRT edge falloff (all baked)
  g.fillStyle = 'rgba(0,0,0,0.28)';
  for (let y = q - 1; y < FH; y += q) g.fillRect(0, y, FW, 1);
  const vg = g.createRadialGradient(FW / 2, FH / 2, FH * 0.45, FW / 2, FH / 2, FW * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = vg;
  g.fillRect(0, 0, FW, FH);
  g.restore();
  return cv;
}

/** The look's arena as a container for the bake stack (one sprite). */
export function buildLookScenery(look: LookId, r: Rect, W: number, H: number, pad: number, p: Palette, arenaKind?: string): Container {
  const draw = look === 'toybox' ? drawToyArena : look === 'cosmos' ? drawCosmosArena : look === 'retro' ? drawRetroArena : drawNeonArena;
  const c = new Container();
  const s = new Sprite(Texture.from(draw(r, W, H, pad, p, arenaKind)));
  s.position.set(-pad, -pad);
  c.addChild(s);
  return c;
}

