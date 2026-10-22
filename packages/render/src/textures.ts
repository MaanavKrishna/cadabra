import { Rectangle, Texture } from 'pixi.js';
import type { ParticleTex } from './juice';
import type { ShapeKind, SpriteSource } from './sprites';
import { darken, hexToNum, lighten } from './theme';

/** Art is downscaled once on load: crisp at TV size, ~100 KB of VRAM each. */
const ART_MAX = 192;
const SHAPE_SIZE = 128;
const CELL = 64;

export const ATLAS_CELLS: (ParticleTex | 'arrow' | 'crown' | 'soft')[] = [
  'dot', 'glow', 'spark', 'confetti', 'smoke', 'drop', 'star', 'ring', 'arrow', 'crown', 'soft',
];

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function css(n: number, a = 1): string {
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function starPath(g: CanvasRenderingContext2D, cx: number, cy: number, points: number, outer: number, inner: number, rot = -Math.PI / 2): void {
  g.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rot + (i * Math.PI) / points;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Glossy procedural stand-ins in palette colours, matching the pack's soft 3D look. */
function drawShape(shape: ShapeKind, color: number, accent: number): HTMLCanvasElement {
  const S = SHAPE_SIZE, c = canvas(S, S), g = c.getContext('2d')!;
  const cx = S / 2, cy = S / 2;
  const body = (r: number, oy = 0) => {
    const grad = g.createRadialGradient(cx - r * 0.35, cy + oy - r * 0.4, r * 0.1, cx, cy + oy, r);
    grad.addColorStop(0, css(lighten(color, 0.55)));
    grad.addColorStop(0.55, css(color));
    grad.addColorStop(1, css(darken(color, 0.45)));
    return grad;
  };
  const outline = () => {
    g.lineWidth = 4;
    g.strokeStyle = css(darken(color, 0.65));
    g.stroke();
  };
  const shine = (x: number, y: number, rx: number, ry: number) => {
    g.beginPath();
    g.ellipse(x, y, rx, ry, -0.5, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fill();
  };
  switch (shape) {
    case 'blob':
    case 'guard': {
      const r = shape === 'guard' ? 54 : 48;
      if (shape === 'guard') {
        for (const s of [-1, 1]) {
          g.beginPath();
          g.arc(cx + s * r * 0.62, cy - r * 0.72, r * 0.3, 0, Math.PI * 2);
          g.fillStyle = css(darken(color, 0.15));
          g.fill();
        }
      }
      g.beginPath();
      g.ellipse(cx, cy + 4, r, r * 0.92, 0, 0, Math.PI * 2);
      g.fillStyle = body(r, 4);
      g.fill();
      outline();
      shine(cx - r * 0.38, cy - r * 0.42, r * 0.22, r * 0.12);
      for (const s of [-1, 1]) {
        g.beginPath();
        g.ellipse(cx + s * r * 0.32, cy - 2, r * 0.17, r * 0.21, 0, 0, Math.PI * 2);
        g.fillStyle = '#fff';
        g.fill();
        g.beginPath();
        g.arc(cx + s * r * 0.32 + 2, cy + 1, r * 0.09, 0, Math.PI * 2);
        g.fillStyle = '#1a1a2a';
        g.fill();
      }
      g.beginPath();
      g.arc(cx, cy + r * 0.3, r * 0.16, 0.15 * Math.PI, 0.85 * Math.PI);
      g.lineWidth = 3;
      g.strokeStyle = css(darken(color, 0.7));
      g.stroke();
      break;
    }
    case 'orb': {
      const halo = g.createRadialGradient(cx, cy, 20, cx, cy, 62);
      halo.addColorStop(0, css(lighten(color, 0.3), 0.6));
      halo.addColorStop(1, css(color, 0));
      g.fillStyle = halo;
      g.fillRect(0, 0, S, S);
      g.beginPath();
      g.arc(cx, cy, 36, 0, Math.PI * 2);
      g.fillStyle = body(36);
      g.fill();
      outline();
      shine(cx - 12, cy - 14, 10, 6);
      break;
    }
    case 'spiky': {
      starPath(g, cx, cy, 9, 58, 36, 0);
      g.fillStyle = body(58);
      g.fill();
      outline();
      g.beginPath();
      g.arc(cx, cy, 24, 0, Math.PI * 2);
      const core = g.createRadialGradient(cx - 6, cy - 6, 2, cx, cy, 24);
      core.addColorStop(0, '#fff');
      core.addColorStop(1, css(accent));
      g.fillStyle = core;
      g.fill();
      break;
    }
    case 'ring': {
      g.beginPath();
      g.arc(cx, cy, 48, 0, Math.PI * 2);
      g.lineWidth = 14;
      g.strokeStyle = css(color);
      g.stroke();
      g.lineWidth = 4;
      g.strokeStyle = css(lighten(color, 0.6));
      g.stroke();
      break;
    }
    case 'block': {
      roundRect(g, 18, 18, 92, 92, 18);
      g.fillStyle = body(64);
      g.fill();
      outline();
      roundRect(g, 30, 28, 40, 14, 7);
      g.fillStyle = 'rgba(255,255,255,0.45)';
      g.fill();
      break;
    }
    case 'pad': {
      roundRect(g, 10, 26, 108, 76, 20);
      g.fillStyle = body(64);
      g.fill();
      outline();
      g.lineWidth = 8;
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineCap = 'round';
      for (const dx of [-18, 10]) {
        g.beginPath();
        g.moveTo(cx + dx - 8, cy - 18);
        g.lineTo(cx + dx + 10, cy);
        g.lineTo(cx + dx - 8, cy + 18);
        g.stroke();
      }
      break;
    }
    case 'gem':
    default: {
      g.beginPath();
      g.moveTo(cx, 10);
      g.lineTo(cx + 46, cy - 12);
      g.lineTo(cx, S - 10);
      g.lineTo(cx - 46, cy - 12);
      g.closePath();
      g.fillStyle = body(56);
      g.fill();
      outline();
      shine(cx - 14, cy - 20, 10, 6);
    }
  }
  return c;
}

function drawCell(g: CanvasRenderingContext2D, kind: (typeof ATLAS_CELLS)[number], ox: number): void {
  const cx = ox + CELL / 2, cy = CELL / 2, R = CELL / 2 - 2;
  g.save();
  g.clearRect(ox, 0, CELL, CELL);
  switch (kind) {
    case 'dot': {
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.6);
      gr.addColorStop(0, '#fff');
      gr.addColorStop(0.7, '#fff');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(ox, 0, CELL, CELL);
      break;
    }
    case 'glow':
    case 'soft': {
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R);
      if (kind === 'glow') {
        gr.addColorStop(0, 'rgba(255,255,255,1)');
        gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
      } else {
        gr.addColorStop(0, 'rgba(255,255,255,0.9)');
        gr.addColorStop(0.5, 'rgba(255,255,255,0.5)');
      }
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(ox, 0, CELL, CELL);
      break;
    }
    case 'spark':
      starPath(g, cx, cy, 4, R, R * 0.18);
      g.fillStyle = '#fff';
      g.fill();
      break;
    case 'star':
      starPath(g, cx, cy, 5, R * 0.9, R * 0.42);
      g.fillStyle = '#fff';
      g.fill();
      break;
    case 'confetti':
      roundRect(g, cx - 14, cy - 7, 28, 14, 3);
      g.fillStyle = '#fff';
      g.fill();
      break;
    case 'smoke': {
      for (const [dx, dy, r] of [[-8, 4, 14], [8, 2, 15], [0, -8, 15], [0, 6, 16]] as const) {
        const gr = g.createRadialGradient(cx + dx, cy + dy, 0, cx + dx, cy + dy, r);
        gr.addColorStop(0, 'rgba(255,255,255,0.75)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(ox, 0, CELL, CELL);
      }
      break;
    }
    case 'drop':
      g.beginPath();
      g.moveTo(cx, cy - R * 0.9);
      g.quadraticCurveTo(cx + R * 0.6, cy + R * 0.1, cx, cy + R * 0.6);
      g.quadraticCurveTo(cx - R * 0.6, cy + R * 0.1, cx, cy - R * 0.9);
      g.fillStyle = '#fff';
      g.fill();
      break;
    case 'ring':
      g.beginPath();
      g.arc(cx, cy, R - 4, 0, Math.PI * 2);
      g.lineWidth = 5;
      g.strokeStyle = '#fff';
      g.stroke();
      break;
    case 'arrow':
      // chevron pointing +x
      g.beginPath();
      g.moveTo(cx - 14, cy - 20);
      g.lineTo(cx + 16, cy);
      g.lineTo(cx - 14, cy + 20);
      g.lineTo(cx - 4, cy);
      g.closePath();
      g.fillStyle = '#fff';
      g.fill();
      break;
    case 'crown':
      g.beginPath();
      g.moveTo(cx - 22, cy + 14);
      g.lineTo(cx - 24, cy - 12);
      g.lineTo(cx - 11, cy);
      g.lineTo(cx, cy - 18);
      g.lineTo(cx + 11, cy);
      g.lineTo(cx + 24, cy - 12);
      g.lineTo(cx + 22, cy + 14);
      g.closePath();
      g.fillStyle = '#fff';
      g.fill();
      break;
  }
  g.restore();
}

/** What the store needs from a decoded image. */
export interface Img {
  naturalWidth: number;
  naturalHeight: number;
}
export type ImageLoader = (url: string) => Promise<Img>;

function loadImage(url: string): Promise<Img> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (/^https?:/.test(url) && !url.startsWith(location.origin)) img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = url;
  });
}

/** Downscale with high-quality smoothing (one pass per halving keeps it sharp). */
function shrink(img: Img, max: number): HTMLCanvasElement {
  let w = img.naturalWidth, h = img.naturalHeight;
  let src = img as unknown as CanvasImageSource;
  while (Math.max(w, h) / 2 >= max) {
    const c = canvas(Math.ceil(w / 2), Math.ceil(h / 2));
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    src = c;
    w = c.width;
    h = c.height;
  }
  const k = Math.min(1, max / Math.max(w, h));
  const out = canvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
  const g = out.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

/**
 * Texture cache keyed by URL (and target size), so two games that use the same sprite key
 * with different art never share a texture. `get()` never blocks: it hands back the
 * procedural shape until the art has loaded. Failures are remembered per theme only.
 */
export class TextureStore {
  private art = new Map<string, Texture>();
  private loading = new Map<string, Promise<Texture | null>>();
  private failed = new Set<string>();
  private shapes = new Map<string, Texture>();
  /** Cache ids loaded for the current theme's generated art (evicted on the next theme). */
  private themeOwned = new Set<string>();
  private destroyed = false;
  private readonly loader: ImageLoader;
  readonly atlas: HTMLCanvasElement;
  readonly atlasTex: Texture;
  readonly cells: Record<string, Texture> = {};

  constructor(opts: { loadImage?: ImageLoader } = {}) {
    this.loader = opts.loadImage ?? loadImage;
    this.atlas = canvas(CELL * ATLAS_CELLS.length, CELL);
    const g = this.atlas.getContext('2d')!;
    ATLAS_CELLS.forEach((k, i) => drawCell(g, k, i * CELL));
    this.atlasTex = Texture.from(this.atlas);
    ATLAS_CELLS.forEach((k, i) => {
      this.cells[k] = new Texture({ source: this.atlasTex.source, frame: new Rectangle(i * CELL, 0, CELL, CELL) });
    });
  }

  cell(k: (typeof ATLAS_CELLS)[number]): Texture {
    return this.cells[k]!;
  }

  /** Swap pack fx-* art into the particle atlas where present (same texture source). */
  async useFxArt(urls: Record<string, string>): Promise<void> {
    const map: [string, (typeof ATLAS_CELLS)[number]][] = [['fx-sparkle', 'spark'], ['fx-smoke', 'smoke'], ['fx-starburst', 'star']];
    const g = this.atlas.getContext('2d')!;
    let changed = false;
    await Promise.all(map.map(async ([name, cellKey]) => {
      const url = urls[name];
      if (!url) return;
      try {
        const img = await this.loader(url);
        if (this.destroyed) return;
        const i = ATLAS_CELLS.indexOf(cellKey);
        g.clearRect(i * CELL, 0, CELL, CELL);
        const k = Math.min(CELL / img.naturalWidth, CELL / img.naturalHeight);
        const w = img.naturalWidth * k, h = img.naturalHeight * k;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img as unknown as CanvasImageSource, i * CELL + (CELL - w) / 2, (CELL - h) / 2, w, h);
        changed = true;
      } catch {
        // keep the procedural cell
      }
    }));
    if (changed && !this.destroyed) this.atlasTex.source.update();
  }

  shape(shape: ShapeKind, color: string, accent: string): Texture {
    const k = `${shape}|${color}|${accent}`;
    let t = this.shapes.get(k);
    if (!t) {
      t = Texture.from(drawShape(shape, hexToNum(color), hexToNum(accent)));
      this.shapes.set(k, t);
    }
    return t;
  }

  private static id(url: string, max: number): string {
    return `${max}|${url}`;
  }

  /**
   * Start a new game's theme: forget failures (a URL that failed last game gets another
   * try) and evict generated art from the previous theme that `keep` no longer lists. Call
   * only when no view still shows the old art (GameView clears its views first).
   */
  beginTheme(keep: Iterable<string>): void {
    this.failed.clear();
    const urls = new Set(keep);
    for (const id of this.themeOwned) {
      const url = id.slice(id.indexOf('|') + 1);
      if (urls.has(url)) continue;
      this.art.get(id)?.destroy(true);
      this.art.delete(id);
      this.themeOwned.delete(id);
    }
  }

  /** Ready texture for a URL, or undefined while loading / after failure. */
  loaded(url: string, max = ART_MAX): Texture | undefined {
    return this.art.get(TextureStore.id(url, max));
  }

  /** Load (once) a URL as a downscaled texture. `theme` marks generated art for eviction. */
  load(url: string, max = ART_MAX, theme = false): Promise<Texture | null> {
    const id = TextureStore.id(url, max);
    if (theme) this.themeOwned.add(id);
    const have = this.art.get(id);
    if (have) return Promise.resolve(have);
    if (this.failed.has(id) || this.destroyed) return Promise.resolve(null);
    let p = this.loading.get(id);
    if (!p) {
      p = this.loader(url)
        .then((img) => {
          if (this.destroyed) return null; // resolved after teardown: discard
          const t = Texture.from(shrink(img, max));
          this.art.set(id, t);
          return t;
        })
        .catch(() => {
          this.failed.add(id);
          return null;
        })
        .finally(() => this.loading.delete(id));
      this.loading.set(id, p);
    }
    return p;
  }

  /** Best texture for a source right now (kicks off loading). `fallback` shape while loading. */
  get(src: SpriteSource, fallback: SpriteSource & { type: 'shape' }): Texture {
    if (src.type === 'shape') return this.shape(src.shape, src.color, src.accent);
    const t = this.art.get(TextureStore.id(src.url, ART_MAX));
    if (t) return t;
    void this.load(src.url, ART_MAX, src.key.startsWith('art:'));
    return this.shape(fallback.shape, fallback.color, fallback.accent);
  }

  destroy(): void {
    this.destroyed = true;
    for (const t of this.art.values()) t.destroy(true);
    for (const t of this.shapes.values()) t.destroy(true);
    for (const t of Object.values(this.cells)) t.destroy(false);
    this.atlasTex.destroy(true);
    this.art.clear();
    this.shapes.clear();
    this.loading.clear();
  }
}
