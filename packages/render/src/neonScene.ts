/**
 * The neon arena (task N1 §2): deep navy, a faint grid on the play floor, a perspective
 * synthwave grid in the surround, baked scanlines, a glowing border in the theme accent and
 * corner brackets. Drawn ONCE with Canvas 2D (shadowBlur glow is free here, it never runs per
 * frame) and handed to the background bake as one sprite.
 */
import { Container, Sprite, Texture } from 'pixi.js';
import type { Rect } from './scenery';
import { gridRows, NEON } from './neon';
import { darken, hexToNum, lighten, type Palette } from './theme';

function css(n: number, a = 1): string {
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function glowLine(g: CanvasRenderingContext2D, c: number, w: number, blur: number, a = 1): void {
  g.save();
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.shadowColor = css(c, a);
  g.shadowBlur = blur;
  g.strokeStyle = css(c, 0.5 * a);
  g.lineWidth = w * 2.2;
  g.stroke();
  g.shadowBlur = blur * 0.4;
  g.strokeStyle = css(c, a);
  g.lineWidth = w;
  g.stroke();
  g.shadowBlur = 0;
  g.strokeStyle = css(lighten(c, 0.7), a);
  g.lineWidth = Math.max(1, w * 0.35);
  g.stroke();
  g.restore();
}

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export interface NeonSceneOpts {
  /** Grid cell size on the floor, screen px (default: about 1/16 of the arena width). */
  cell?: number;
}

/** Canvas of the whole background, [-pad, W+pad] x [-pad, H+pad] (origin at -pad). */
export function drawNeonArena(r: Rect, W: number, H: number, pad: number, p: Palette, arenaKind?: string, o: NeonSceneOpts = {}): HTMLCanvasElement {
  const FW = Math.ceil(W + pad * 2), FH = Math.ceil(H + pad * 2);
  const cv = document.createElement('canvas');
  cv.width = FW;
  cv.height = FH;
  const g = cv.getContext('2d')!;
  g.translate(pad, pad);
  const bg = hexToNum(p.bg);
  const prim = hexToNum(p.primary), acc = hexToNum(p.accent);
  const s = H / 720;

  // ---- surround: navy with a soft centre lift (vignette baked in) ----
  const grd = g.createRadialGradient(W / 2, H / 2, H * 0.15, W / 2, H / 2, W * 0.75);
  grd.addColorStop(0, css(lighten(bg, 0.06)));
  grd.addColorStop(0.6, css(bg));
  grd.addColorStop(1, css(darken(bg, 0.55)));
  g.fillStyle = grd;
  g.fillRect(-pad, -pad, FW, FH);

  // synthwave perspective grid: a floor below the arena and a ceiling above, in the accent
  const vpX = W / 2;
  const persp = (y0: number, y1: number, dir: 1 | -1) => {
    g.save();
    g.beginPath();
    g.rect(-pad, Math.min(y0, y1), FW, Math.abs(y1 - y0));
    g.clip();
    const rows = gridRows(0, 1, 7);
    for (const k of rows) {
      const y = y0 + (y1 - y0) * k;
      g.beginPath();
      g.moveTo(-pad, y);
      g.lineTo(W + pad, y);
      g.strokeStyle = css(acc, 0.05 + 0.18 * k);
      g.lineWidth = 1 + k;
      g.stroke();
    }
    for (let i = -12; i <= 12; i++) {
      const xf = vpX + i * 46 * s, xn = vpX + i * 260 * s;
      g.beginPath();
      g.moveTo(xf, y0);
      g.lineTo(xn, y1);
      g.strokeStyle = css(acc, 0.13);
      g.lineWidth = 1.2;
      g.stroke();
    }
    g.restore();
    void dir;
  };
  persp(r.y + r.h + 4, H + pad, 1);
  persp(r.y - 4, -pad, -1);

  // ---- the arena floor ----
  const rad = Math.round(Math.min(r.w, r.h) * 0.03);
  rr(g, r.x, r.y, r.w, r.h, rad);
  const fl = g.createLinearGradient(0, r.y, 0, r.y + r.h);
  fl.addColorStop(0, css(lighten(bg, 0.05)));
  fl.addColorStop(1, css(darken(bg, 0.15)));
  g.fillStyle = fl;
  g.fill();
  g.save();
  rr(g, r.x, r.y, r.w, r.h, rad);
  g.clip();
  // faint grid, every 4th line brighter; lanes draw their own markings
  if (arenaKind !== 'lanes') {
    const cell = o.cell ?? Math.max(24, Math.round(r.w / 20));
    let i = 0;
    for (let x = r.x + ((r.w / 2) % cell); x < r.x + r.w; x += cell, i++) {
      g.fillStyle = css(prim, (Math.round((x - r.x - r.w / 2) / cell) % 4 === 0) ? 0.13 : 0.055);
      g.fillRect(Math.round(x), r.y, 1.5, r.h);
    }
    for (let y = r.y + ((r.h / 2) % cell); y < r.y + r.h; y += cell) {
      g.fillStyle = css(prim, (Math.round((y - r.y - r.h / 2) / cell) % 4 === 0) ? 0.13 : 0.055);
      g.fillRect(r.x, Math.round(y), r.w, 1.5);
    }
  }
  // inner edge darkening so the centre reads as lit
  const ig = g.createRadialGradient(r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) * 0.3, r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h) * 0.62);
  ig.addColorStop(0, 'rgba(0,0,0,0)');
  ig.addColorStop(1, 'rgba(0,0,0,0.38)');
  g.fillStyle = ig;
  g.fillRect(r.x, r.y, r.w, r.h);
  g.restore();

  // ---- baked scanlines (every 3 px, over everything) ----
  g.fillStyle = 'rgba(0,0,0,0.16)';
  for (let y = -pad; y < H + pad; y += 3) g.fillRect(-pad, y, FW, 1);

  // ---- border: accent outer glow, primary inner line ----
  rr(g, r.x - 6 * s, r.y - 6 * s, r.w + 12 * s, r.h + 12 * s, rad + 6 * s);
  glowLine(g, acc, 2.5 * s, 18 * s, 0.85);
  rr(g, r.x, r.y, r.w, r.h, rad);
  glowLine(g, prim, 3 * s, 22 * s);

  // ---- corner brackets ----
  const L = 46 * s, off = 16 * s;
  const corners: [number, number, number, number][] = [
    [r.x - off, r.y - off, 1, 1], [r.x + r.w + off, r.y - off, -1, 1], [r.x - off, r.y + r.h + off, 1, -1], [r.x + r.w + off, r.y + r.h + off, -1, -1],
  ];
  for (const [x, y, dx, dy] of corners) {
    g.beginPath();
    g.moveTo(x, y + dy * L);
    g.lineTo(x, y);
    g.lineTo(x + dx * L, y);
    glowLine(g, NEON.white, 3 * s, 16 * s, 0.9);
    g.beginPath();
    g.arc(x + dx * 10 * s, y + dy * 10 * s, 3 * s, 0, Math.PI * 2);
    g.fillStyle = css(prim);
    g.fill();
  }
  // small tick marks along the border (arcade cabinet detail)
  g.fillStyle = css(prim, 0.5);
  for (let i = 1; i < 12; i++) {
    const x = r.x + (r.w * i) / 12;
    g.fillRect(x - 1, r.y - 14 * s, 2, 6 * s);
    g.fillRect(x - 1, r.y + r.h + 8 * s, 2, 6 * s);
  }
  return cv;
}

/** The arena as a container for the bake stack (one sprite). */
export function buildNeonScenery(r: Rect, W: number, H: number, pad: number, p: Palette, arenaKind?: string): Container {
  const c = new Container();
  const tex = Texture.from(drawNeonArena(r, W, H, pad, p, arenaKind));
  const s = new Sprite(tex);
  s.position.set(-pad, -pad);
  c.addChild(s);
  // owner frees it with destroy({ children: true, texture: true, textureSource: true })
  return c;
}

/** A soft horizontal band (2 x 64, white): the slow scanline sweep, tinted and stretched. */
export function bandTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createLinearGradient(0, 0, 0, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0)');
  gr.addColorStop(0.75, 'rgba(255,255,255,0.6)');
  gr.addColorStop(0.92, 'rgba(255,255,255,1)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 2, 64);
  return Texture.from(c);
}
