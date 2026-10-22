import { Container, Sprite, Texture } from 'pixi.js';
import { darken, hexToNum, mix, type Palette } from './theme';

/** Ambient light motes on screen at most (half when the FxBudget is degraded). */
export const MOTE_MAX = 20;
const MOTE_DEGRADED = 8;

const fract = (v: number) => v - Math.floor(v);
/** Stable pseudo-random in [0, 1) per (i, salt). */
const hash = (i: number, salt: number) => fract(Math.sin(i * 127.1 + salt * 311.7) * 43758.5453);

/**
 * Where mote `i` is at time `t` (s): a slow upward drift that wraps, with a lazy sway and a
 * twinkle. Pure and allocation-free (writes into `out`).
 */
export function motePos(i: number, t: number, W: number, H: number, out: { x: number; y: number; a: number; s: number }): void {
  const speed = 6 + hash(i, 1) * 10;
  const y0 = hash(i, 2) * (H + 60);
  out.y = H + 30 - fract((y0 + t * speed) / (H + 60)) * (H + 60);
  out.x = hash(i, 3) * W + Math.sin(t * (0.2 + hash(i, 4) * 0.3) + i) * 26;
  out.a = (0.12 + hash(i, 5) * 0.3) * (0.6 + 0.4 * Math.sin(t * (0.8 + hash(i, 6) * 1.5) + i * 2));
  out.s = 0.07 + hash(i, 7) * 0.12;
}

/**
 * Floor lighting baked into one small texture per palette (radial vignette + a pool of
 * light tinted by the palette), plus a few additive drifting motes. Cheap: one full-screen
 * sprite that replaces the old flat floor shade, and ≤ 20 tiny sprites.
 */
export class Ambience {
  readonly light = new Sprite();
  readonly motes = new Container();
  private sprites: Sprite[] = [];
  private tex?: Texture;
  private readonly m = { x: 0, y: 0, a: 0, s: 0 };

  constructor(glowCell: Texture, private readonly W: number, private readonly H: number, private readonly pad: number) {
    for (let i = 0; i < MOTE_MAX; i++) {
      const s = new Sprite(glowCell);
      s.anchor.set(0.5);
      s.blendMode = 'add';
      this.sprites.push(s);
      this.motes.addChild(s);
    }
    this.light.position.set(-pad, -pad);
  }

  /** Rebuild the light texture for a palette (once per theme). `floor`: a tiled floor is under it. */
  setPalette(p: Palette, floor: boolean): void {
    const bg = hexToNum(p.bg), glow = hexToNum(p.glow), prim = hexToNum(p.primary);
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 180;
    const g = c.getContext('2d')!;
    const rgba = (n: number, a: number) => `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    const dark = darken(bg, 0.35);
    // vignette: darker toward the edges so the middle of the arena reads as lit
    const v = g.createRadialGradient(160, 96, 30, 160, 96, 210);
    v.addColorStop(0, rgba(dark, floor ? 0.32 : 0));
    v.addColorStop(0.6, rgba(dark, floor ? 0.5 : 0.15));
    v.addColorStop(1, rgba(darken(bg, 0.6), floor ? 0.86 : 0.55));
    g.fillStyle = v;
    g.fillRect(0, 0, 320, 180);
    // warm pool of light from above, tinted by the palette
    const l = g.createRadialGradient(160, 20, 4, 160, 40, 190);
    l.addColorStop(0, rgba(mix(glow, 0xffffff, 0.3), 0.2));
    l.addColorStop(0.5, rgba(mix(glow, prim, 0.5), 0.07));
    l.addColorStop(1, rgba(prim, 0));
    g.fillStyle = l;
    g.fillRect(0, 0, 320, 180);
    const old = this.tex;
    this.tex = Texture.from(c);
    this.light.texture = this.tex;
    this.light.width = this.W + this.pad * 2;
    this.light.height = this.H + this.pad * 2;
    old?.destroy(true);
    for (let i = 0; i < this.sprites.length; i++) this.sprites[i]!.tint = i % 3 === 0 ? 0xffffff : glow;
  }

  update(t: number, degraded: boolean): void {
    const n = degraded ? MOTE_DEGRADED : MOTE_MAX;
    const m = this.m;
    for (let i = 0; i < this.sprites.length; i++) {
      const s = this.sprites[i]!;
      s.visible = i < n;
      if (!s.visible) continue;
      motePos(i, t, this.W, this.H, m);
      s.position.set(m.x, m.y);
      s.alpha = m.a;
      s.scale.set(m.s);
    }
  }

  destroy(): void {
    this.motes.destroy({ children: true });
    this.light.destroy();
    this.tex?.destroy(true);
  }
}
