/**
 * Sense of place (task F §2): the arena is a framed stage inside a themed surround with props
 * from the default art pack along its edges (a kitchen counter with plates of ladoos, an ice
 * floe in a lava sea, a fenced field with a mud pit...). Everything here is drawn ONCE into the
 * background bake (background.ts), so it costs nothing per frame on the stick.
 */
import { Container, Graphics, Sprite, TilingSprite, type Texture } from 'pixi.js';
import type { Theme } from '@cadabra/spec';
import { darken, hexToNum, lighten, mix, type Palette } from './theme';

export type SceneKind = 'kitchen' | 'lava' | 'ice' | 'field' | 'generic';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Share of the screen the arena fills; the rest is frame and scenery (title-safe margins). */
export const ARENA_FILL = 0.88;

/** Where the arena sits on screen and its world->screen scale. */
export function arenaRect(W: number, H: number, arenaW: number, arenaH: number, fill = ARENA_FILL): Rect & { k: number } {
  const k = Math.min((W * fill) / arenaW, (H * fill) / arenaH);
  const w = arenaW * k, h = arenaH * k;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h, k };
}

/** Pick the scene from the theme's words (sprite prompts, key art, style) and the arena kind. */
export function sceneFor(theme: Pick<Theme, 'sprites' | 'keyArtPrompt' | 'artStyle'>, arenaKind?: string): SceneKind {
  const words = `${Object.keys(theme.sprites).join(' ')} ${Object.values(theme.sprites).join(' ')} ${theme.keyArtPrompt ?? ''}`.toLowerCase();
  if (arenaKind === 'tug') return 'field';
  if (/lava|volcan|magma|penguin/.test(words)) return 'lava';
  if (/kitchen|ladoo|grandma|cookie|cake|bakery|sweets?\b|candy|pantry/.test(words)) return 'kitchen';
  if (/\bice\b|snow|frozen|arctic|glacier/.test(words)) return 'ice';
  if (/grass|garden|forest|farm|meadow|field|jungle|park/.test(words)) return 'field';
  return 'generic';
}

/** Pack art a scene draws (file stems): arena floor first, then the surround and props. */
export const SCENE_ART: Record<SceneKind, { floor?: string; surround?: string; props: string[] }> = {
  kitchen: { floor: 'floor-kitchen', props: ['ladoo', 'crate', 'gift-box', 'grandma-guard'] },
  lava: { floor: 'floor-volcanic', props: ['lava', 'ice-shard', 'golden-fish'] },
  ice: { floor: 'floor-ice', props: ['ice-shard', 'golden-fish'] },
  field: { floor: 'floor-grass', surround: 'floor-grass', props: ['banner-red', 'banner-blue', 'crate'] },
  generic: { props: ['star', 'gem'] },
};

export interface SceneTex {
  /** Pack art by stem (undefined while missing: that prop is skipped). */
  (name: string): Texture | undefined;
}

function prop(c: Container, tex: Texture | undefined, x: number, y: number, size: number, rot = 0, flip = false, alpha = 1): void {
  if (!tex) return;
  const s = new Sprite(tex);
  s.anchor.set(0.5, 0.75);
  const k = size / Math.max(1, tex.width, tex.height);
  s.scale.set(flip ? -k : k, k);
  s.position.set(x, y);
  s.rotation = rot;
  s.alpha = alpha;
  // soft contact shadow under each prop
  const sh = new Graphics().ellipse(x, y + size * 0.18, size * 0.42, size * 0.12).fill({ color: 0x000000, alpha: 0.35 });
  c.addChild(sh, s);
}

/**
 * Build the scene for the bake stack (screen px; extends `pad` past the screen). `custom` is a
 * generated floor/backdrop texture that replaces the pack floor inside the arena.
 */
export function buildScenery(kind: SceneKind, r: Rect, W: number, H: number, pad: number, tex: SceneTex, p: Palette, custom?: Texture, arenaKind?: string): Container {
  const c = new Container();
  const bg = hexToNum(p.bg), prim = hexToNum(p.primary), glow = hexToNum(p.glow), acc = hexToNum(p.accent);
  const X0 = -pad, Y0 = -pad, FW = W + pad * 2, FH = H + pad * 2;
  const art = SCENE_ART[kind];
  const rad = Math.round(Math.min(r.w, r.h) * 0.045);

  // ---- surround ----
  const surroundCol = kind === 'kitchen' ? 0x2a170d : kind === 'lava' ? 0x1a0904 : kind === 'ice' ? 0x0a2440 : kind === 'field' ? 0x123018 : darken(bg, 0.35);
  c.addChild(new Graphics().rect(X0, Y0, FW, FH).fill({ color: surroundCol }));
  const sTex = art.surround ? tex(art.surround) : undefined;
  if (sTex) {
    sTex.source.addressMode = 'repeat';
    const t = new TilingSprite({ texture: sTex, width: FW, height: FH });
    t.position.set(X0, Y0);
    t.tileScale.set(0.6);
    t.tint = kind === 'field' ? 0x6f8f62 : 0xb08070;
    c.addChild(t);
  }
  if (kind === 'kitchen') {
    // wainscot stripes on the wall
    const g = new Graphics();
    for (let x = X0; x < X0 + FW; x += 46) g.rect(x, Y0, 22, FH).fill({ color: 0x3a2214, alpha: 0.55 });
    c.addChild(g);
  } else if (kind === 'ice') {
    const g = new Graphics();
    for (let i = 0; i < 40; i++) {
      const x = X0 + ((i * 397) % FW), y = Y0 + ((i * 211) % FH);
      g.roundRect(x, y, 40 + (i % 3) * 20, 5, 3).fill({ color: 0x5fb6ff, alpha: 0.25 });
    }
    c.addChild(g);
  } else if (kind === 'generic') {
    const g = new Graphics();
    for (let y = Y0; y < Y0 + FH; y += 36) for (let x = X0 + ((y / 36) % 2) * 18; x < X0 + FW; x += 36) g.circle(x, y, 2.2).fill({ color: lighten(bg, 0.25), alpha: 0.35 });
    c.addChild(g);
  }

  // ---- drop shadow of the arena slab ----
  const sh = new Graphics();
  for (let i = 6; i >= 1; i--) sh.roundRect(r.x - i * 3, r.y - i * 2 + 10, r.w + i * 6, r.h + i * 5, rad + i * 3).fill({ color: 0x000000, alpha: 0.07 });
  c.addChild(sh);

  // ---- arena floor (masked to a rounded slab) ----
  const floorTex = custom ?? (art.floor ? tex(art.floor) : undefined);
  const slab = new Container();
  const base = new Graphics().roundRect(r.x, r.y, r.w, r.h, rad).fill({ color: kind === 'generic' ? lighten(bg, 0.08) : mix(bg, 0x808080, 0.25) });
  slab.addChild(base);
  if (floorTex) {
    if (custom) {
      const s = new Sprite(floorTex);
      const k = Math.max(r.w / floorTex.width, r.h / floorTex.height);
      s.anchor.set(0.5);
      s.scale.set(k);
      s.position.set(r.x + r.w / 2, r.y + r.h / 2);
      slab.addChild(s);
    } else {
      floorTex.source.addressMode = 'repeat';
      const t = new TilingSprite({ texture: floorTex, width: r.w, height: r.h });
      t.position.set(r.x, r.y);
      t.tileScale.set(kind === 'kitchen' ? 0.55 : 0.7);
      // toned into the palette so sprites read on top
      t.tint = kind === 'lava' ? 0xffb080 : kind === 'ice' ? 0xe8f4ff : mix(0xffffff, lighten(bg, 0.25), 0.4);
      slab.addChild(t);
    }
    const mask = new Graphics().roundRect(r.x, r.y, r.w, r.h, rad).fill({ color: 0xffffff });
    slab.addChild(mask);
    slab.mask = mask;
  }
  c.addChild(slab);

  // inner shade: the slab darkens toward its rim, so the middle reads as lit
  const inner = new Graphics();
  for (let i = 0; i < 7; i++) {
    const d = i * Math.min(r.w, r.h) * 0.018;
    inner.roundRect(r.x + d, r.y + d, r.w - d * 2, r.h - d * 2, Math.max(4, rad - d * 0.5)).stroke({ width: Math.min(r.w, r.h) * 0.02, color: 0x000000, alpha: 0.09 - i * 0.011 });
  }
  c.addChild(inner);

  // tug: the mud pit in the middle (losers fall in)
  if (arenaKind === 'tug') {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2 + r.h * 0.06, mw = r.w * 0.11, mh = r.h * 0.16;
    const m = new Graphics()
      .ellipse(cx, cy + 8, mw + 14, mh + 10).fill({ color: 0x2b1708, alpha: 0.6 })
      .ellipse(cx, cy, mw + 8, mh + 6).fill({ color: 0x6b4423 })
      .ellipse(cx, cy, mw, mh).fill({ color: 0x4a2c14 })
      .ellipse(cx - mw * 0.25, cy - mh * 0.3, mw * 0.45, mh * 0.18).fill({ color: 0x8a5a33, alpha: 0.55 });
    for (let i = 0; i < 6; i++) m.circle(cx + Math.cos(i * 2.1) * mw * 0.6, cy + Math.sin(i * 2.1) * mh * 0.55, 5 + (i % 3) * 3).stroke({ width: 2, color: 0x9a6a40, alpha: 0.7 });
    c.addChild(m);
  }

  // ---- rim ----
  const rimCol = kind === 'kitchen' ? 0xc8894f : kind === 'lava' ? 0x6b4a3a : kind === 'ice' ? 0xe6f7ff : kind === 'field' ? 0x8a5a33 : lighten(prim, 0.1);
  const rim = new Graphics()
    .roundRect(r.x - 7, r.y - 7, r.w + 14, r.h + 14, rad + 7).stroke({ width: 12, color: darken(rimCol, 0.45) })
    .roundRect(r.x - 6, r.y - 6, r.w + 12, r.h + 12, rad + 6).stroke({ width: 7, color: rimCol })
    .roundRect(r.x - 8, r.y - 9, r.w + 16, r.h + 12, rad + 8).stroke({ width: 2, color: lighten(rimCol, 0.5), alpha: 0.8 });
  c.addChild(rim);
  if (kind === 'lava') {
    // molten glow licking the floe
    const gl = new Graphics();
    for (let i = 1; i <= 5; i++) gl.roundRect(r.x - 8 - i * 7, r.y - 8 - i * 7, r.w + 16 + i * 14, r.h + 16 + i * 14, rad + 8 + i * 7).stroke({ width: 8, color: 0xff6a1a, alpha: 0.16 - i * 0.025 });
    gl.blendMode = 'add';
    c.addChild(gl);
  }

  // ---- props along the edges (never over the top-centre timer or the bottom chips) ----
  const mL = r.x, mT = r.y, size = Math.max(70, Math.min(mL, mT) * 1.5);
  const T = (n: string) => tex(n);
  if (kind === 'kitchen') {
    // a counter along the top with plates of ladoos
    const cy = mT * 0.62;
    const counter = new Graphics()
      .rect(X0, Y0, FW, cy + 18).fill({ color: 0x5a3519 })
      .rect(X0, cy - 6, FW, 14).fill({ color: 0xb07a4a })
      .rect(X0, cy + 8, FW, 10).fill({ color: 0x3b2110, alpha: 0.9 });
    c.addChild(counter);
    const plates = [0.1, 0.24, 0.76, 0.9];
    for (const fx of plates) {
      const px = W * fx;
      c.addChild(new Graphics().ellipse(px, cy, size * 0.62, size * 0.2).fill({ color: 0xf4efe6 }).ellipse(px, cy, size * 0.48, size * 0.14).stroke({ width: 3, color: 0xd9cdb8 }));
      const l = T('ladoo');
      prop(c, l, px - size * 0.2, cy + 4, size * 0.42);
      prop(c, l, px + size * 0.2, cy + 4, size * 0.42);
      prop(c, l, px, cy - size * 0.1, size * 0.42);
    }
    prop(c, T('crate'), mL * 0.5, H * 0.55, size * 0.9, -0.05);
    prop(c, T('gift-box'), W - mL * 0.5, H * 0.45, size * 0.8, 0.06);
    prop(c, T('grandma-guard'), W - mL * 0.55, H - mT * 0.15, size * 1.5, 0, true);
    prop(c, T('crate'), mL * 0.55, H - mT * 0.1, size, 0.04);
  } else if (kind === 'lava') {
    const lv = T('lava');
    const spots: [number, number, number][] = [[0.03, 0.2, 1.1], [0.97, 0.3, 1.2], [0.04, 0.78, 1], [0.96, 0.85, 1.1], [0.2, 0.02, 0.9], [0.8, 0.02, 0.9], [0.3, 0.99, 0.9], [0.7, 0.99, 1]];
    for (const [fx, fy, s] of spots) prop(c, lv, W * fx, H * fy + size * 0.2, size * s, (fx * 7) % 1);
    prop(c, T('ice-shard'), r.x + 22, r.y + 30, size * 0.8, -0.3);
    prop(c, T('ice-shard'), r.x + r.w - 22, r.y + r.h - 6, size * 0.75, 0.4);
  } else if (kind === 'ice') {
    prop(c, T('ice-shard'), mL * 0.5, H * 0.3, size, -0.2);
    prop(c, T('ice-shard'), W - mL * 0.5, H * 0.7, size, 0.3);
    prop(c, T('golden-fish'), mL * 0.5, H * 0.8, size * 0.6, 0.4);
  } else if (kind === 'field') {
    // fences top and bottom
    const f = new Graphics();
    for (const fy of [mT * 0.55, H - mT * 0.45]) {
      f.rect(X0, fy - 14, FW, 8).fill({ color: 0x9a6a3c }).rect(X0, fy + 4, FW, 8).fill({ color: 0x9a6a3c });
      for (let x = X0 + 10; x < X0 + FW; x += 70) f.roundRect(x, fy - 26, 12, 46, 4).fill({ color: 0x7a4f2a }).rect(x, fy - 26, 12, 5).fill({ color: 0xb0804e });
    }
    c.addChild(f);
    prop(c, T('crate'), mL * 0.5, H * 0.5, size * 0.9);
    prop(c, T('crate'), W - mL * 0.5, H * 0.5, size * 0.9, 0, true);
  } else {
    prop(c, T('star'), mL * 0.5, mT + size * 0.3, size * 0.6, -0.2, false, 0.9);
    prop(c, T('gem'), W - mL * 0.5, H - mT, size * 0.6, 0.2, false, 0.9);
    const g = new Graphics();
    for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]] as const) g.circle(x, y, 10).fill({ color: glow }).circle(x, y, 5).fill({ color: acc });
    c.addChild(g);
  }
  return c;
}
