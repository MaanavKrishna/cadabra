/**
 * Neon arcade look (task N1): palette, the art-key contract with the engine, the pure math the
 * neon views animate with, and the procedural sprite set. Every sprite is drawn ONCE to a canvas
 * (crisp core + pre-baked glow halo, cached per key and tint), so the Fire TV never runs a
 * filter: glow is baked pixels plus a few additive sprites.
 */
import { Texture } from 'pixi.js';
import type { Theme } from '@cadabra/spec';
import { PLAYER_HUES, TEAM_COLORS, lighten, type Palette } from './theme';
import { drawLook, drawNeonProp, type ArtKey } from './lookArt';
import { LOOKS, type LookId } from './looks';

export type RenderStyle = 'neon' | 'cartoon';

export const NEON = {
  bg: 0x0a0e27,
  cyan: 0x00e5ff,
  magenta: 0xff2bd6,
  lime: 0xb6ff3b,
  amber: 0xffb020,
  red: 0xff3355,
  white: 0xffffff,
} as const;

export const NEON_PALETTE: Palette = { bg: '#0A0E27', primary: '#00E5FF', accent: '#FF2BD6', glow: '#B6FF3B', text: '#FFFFFF' };

/** Player colours in join order: cyan, magenta, lime, amber (then extras for > 4). */
export const NEON_PLAYERS: readonly number[] = PLAYER_HUES;
/** Team 0 cyan, team 1 magenta. */
export const NEON_TEAMS: [number, number] = TEAM_COLORS;

/** The default theme when a game ships none (theme id `neon`). */
export const NEON_THEME: Theme = {
  palette: NEON_PALETTE,
  artStyle: 'neon arcade',
  keyArtPrompt: 'neon arcade arena, glowing cyan and magenta outlines on deep navy',
  sprites: {},
  sfxSet: 'neon',
};

/** Art keys the neon renderer draws (contract with the engine specs, Task N2). */
export const NEON_KEYS = [
  'player', 'gem', 'core', 'core-unstable', 'spike', 'laser', 'boost', 'base', 'tile', 'hole', 'finish',
  'ball', 'crate', 'bumper', 'barrel', 'goal',
] as const;
export type NeonKey = (typeof NEON_KEYS)[number];

/** Physics props (round R2): drawn rotated by the body angle, with impact squash. */
export const PROP_KEYS = new Set<string>(['ball', 'crate', 'bumper', 'barrel']);

// 'goal' as a sprite stays the collect block's base zone; the net goal is 'net' / 'goal-net'
const KEYSET = new Set<string>(NEON_KEYS.filter((k) => k !== 'goal'));

/** Words in a free-form sprite key that pick a neon key (AI specs may say 'pizza-core'). */
const WORDS: [RegExp, NeonKey][] = [
  [/\bnet\b|goal-?net|soccer-?goal/, 'goal'],
  [/barrel|tnt|explosive|keg|drum/, 'barrel'],
  [/bumper|pinball|kicker/, 'bumper'],
  [/crate|box|brick|block/, 'crate'],
  [/ball|puck/, 'ball'],
  [/unstable|overload|bomb|volatile|fuse/, 'core-unstable'],
  [/core|orb|energy|battery|reactor/, 'core'],
  [/spike|mine|hazard|lava|fire|saw|blade|danger/, 'spike'],
  [/laser|beam|gate|zap|barrier/, 'laser'],
  [/boost|pad|speed|chevron|turbo/, 'boost'],
  [/hole|void|pit|abyss/, 'hole'],
  [/finish|flag|goal-line/, 'finish'],
  [/tile|cell|paint|floor/, 'tile'],
  [/base|goal|home|zone|basket/, 'base'],
  [/gem|shard|crystal|coin|star|pickup|item|loot|token/, 'gem'],
  [/player|avatar|runner/, 'player'],
];

/** Entity kind -> neon key when the sprite key says nothing we know. */
const BY_KIND: Record<string, NeonKey> = {
  player: 'player', runner: 'player', item: 'gem', pickup: 'gem', hazard: 'spike', guard: 'spike', goal: 'base', base: 'base',
  'safe-zone': 'base', tile: 'tile', 'boost-pad': 'boost', obstacle: 'laser', baton: 'gem', hole: 'hole', finish: 'finish',
  ball: 'ball', crate: 'crate', bumper: 'bumper', barrel: 'barrel', net: 'goal',
};

/**
 * Which neon sprite draws an entity: an exact contract key wins, then a recognised word in the
 * sprite key, then the entity kind (pickup -> gem, hazard -> spike, goal -> base), else gem.
 */
export function neonKey(sprite: string | undefined, kind: string | undefined): NeonKey {
  const s = (sprite ?? '').toLowerCase();
  if (KEYSET.has(s)) return s as NeonKey;
  if (s.startsWith('avatar:')) return 'player';
  if (s === 'net' || s === 'goal-net') return 'goal';
  const k = BY_KIND[kind ?? ''];
  // kinds with a fixed look are not overridden by a loose word match ('hazard' named 'lava-gem')
  if (k && (kind === 'player' || kind === 'runner' || kind === 'tile')) return k;
  for (const [re, key] of WORDS) if (re.test(s)) return key;
  return k ?? 'gem';
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Seconds left on an unstable core's fuse from entity props, if the engine publishes one:
 * `fuse` / `fuseLeft` / `overloadFuse` (seconds left) or `fuseAt` / `detonateAt` (sim time).
 */
export function fuseLeft(props: Record<string, unknown>, time: number): number | undefined {
  const left = num(props.fuseLeft) ?? num(props.overloadFuse) ?? num(props.fuse);
  if (left !== undefined) return Math.max(0, left);
  const at = num(props.fuseAt) ?? num(props.detonateAt);
  return at !== undefined ? Math.max(0, at - time) : undefined;
}

/** Pulse rate (Hz) of an unstable core: 1.5 Hz with lots of fuse left, up to 10 Hz at zero. */
export function fusePulseHz(left: number | undefined, span = 8): number {
  if (left === undefined) return 2.5;
  const k = Math.max(0, Math.min(1, left / span));
  return 10 - 8.5 * Math.sqrt(k);
}

/** Pupil offset (px) toward the direction of travel; still = look ahead slightly. */
export function eyeLook(vx: number, vy: number, max: number, out: { x: number; y: number }): { x: number; y: number } {
  const sp = Math.hypot(vx, vy);
  if (sp < 8) {
    out.x = 0;
    out.y = max * 0.15;
    return out;
  }
  const k = Math.min(1, sp / 160) * max;
  out.x = (vx / sp) * k;
  out.y = (vy / sp) * k;
  return out;
}

/** Eye openness 0..1: a quick blink every 2.6-4.6 s, de-synced per entity id. */
export function blinkOpen(t: number, id: number): number {
  const period = 2.6 + ((id * 0.618) % 1) * 2;
  const ph = (t + id * 1.37) % period;
  const d = 0.14;
  if (ph > d) return 1;
  return Math.abs(ph / d - 0.5) * 2;
}

/** Scrolling chevron offset 0..1 (boost pads), `speed` cycles per second. */
export function scrollPhase(t: number, speed: number, i: number, n: number): number {
  const v = (t * speed + i / n) % 1;
  return v < 0 ? v + 1 : v;
}

/**
 * Perspective floor grid: x positions on the far edge (y0) for each column, converging toward
 * the centre by `squeeze` (0 = straight columns). Rows get closer toward the far edge.
 */
export function gridRows(y0: number, y1: number, rows: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= rows; i++) {
    const k = i / rows;
    out.push(y0 + (y1 - y0) * k * k);
  }
  return out;
}

// ---------------------------------------------------------------- sprite drawing

const S = 128;

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function css(n: number, a = 1): string {
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Stroke the current path as neon: wide blurred halo, the colour line, a white-hot core. */
function neonStroke(g: CanvasRenderingContext2D, c: number, w: number, glow = 14): void {
  g.save();
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.shadowColor = css(c, 0.95);
  g.shadowBlur = glow;
  g.strokeStyle = css(c, 0.55);
  g.lineWidth = w * 1.9;
  g.stroke();
  g.shadowBlur = glow * 0.5;
  g.strokeStyle = css(c);
  g.lineWidth = w;
  g.stroke();
  g.shadowBlur = 0;
  g.strokeStyle = css(lighten(c, 0.75));
  g.lineWidth = Math.max(1.2, w * 0.38);
  g.stroke();
  g.restore();
}

function neonFill(g: CanvasRenderingContext2D, c: number, cx: number, cy: number, r: number, a0 = 0.42, a1 = 0.12): void {
  const gr = g.createRadialGradient(cx, cy - r * 0.2, r * 0.1, cx, cy, r);
  gr.addColorStop(0, css(lighten(c, 0.35), a0));
  gr.addColorStop(1, css(c, a1));
  g.fillStyle = gr;
  g.fill();
}

function poly(g: CanvasRenderingContext2D, cx: number, cy: number, n: number, r: number, rot = -Math.PI / 2): void {
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot + (i * Math.PI * 2) / n;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

/** Squircle (superellipse n=4) path: the player body. */
function squircle(g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void {
  g.beginPath();
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const x = cx + Math.sign(c) * Math.pow(Math.abs(c), 0.5) * rx;
    const y = cy + Math.sign(s) * Math.pow(Math.abs(s), 0.5) * ry;
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

function chevron(g: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number): void {
  g.beginPath();
  g.moveTo(cx - w / 2, cy - h / 2);
  g.lineTo(cx + w / 2, cy);
  g.lineTo(cx - w / 2, cy + h / 2);
}

/** Draw one neon sprite in colour `c` (canvas S x S, art centred, glow inside the canvas). */
export function drawNeon(key: NeonKey | 'beam' | 'eye' | 'ring', c: number): HTMLCanvasElement {
  if (key === 'beam') {
    // horizontal beam slice: stretched along x at runtime; white-hot centre, colour falloff
    const cv = canvas(4, 64), g = cv.getContext('2d')!;
    const gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, css(c, 0));
    gr.addColorStop(0.3, css(c, 0.35));
    gr.addColorStop(0.44, css(c, 1));
    gr.addColorStop(0.5, css(0xffffff, 1));
    gr.addColorStop(0.56, css(c, 1));
    gr.addColorStop(0.7, css(c, 0.35));
    gr.addColorStop(1, css(c, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 4, 64);
    return cv;
  }
  const cv = canvas(S, S), g = cv.getContext('2d')!;
  const cx = S / 2, cy = S / 2;
  switch (key) {
    case 'player': {
      squircle(g, cx, cy + 2, 40, 38);
      neonFill(g, c, cx, cy, 44, 0.55, 0.22);
      neonStroke(g, c, 5, 16);
      // glossy top highlight
      g.beginPath();
      g.ellipse(cx - 12, cy - 22, 14, 5, -0.25, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fill();
      break;
    }
    case 'eye': {
      g.beginPath();
      g.ellipse(cx, cy, 30, 38, 0, 0, Math.PI * 2);
      g.fillStyle = '#ffffff';
      g.shadowColor = 'rgba(255,255,255,0.6)';
      g.shadowBlur = 10;
      g.fill();
      break;
    }
    case 'ring': {
      g.beginPath();
      g.arc(cx, cy, 50, 0, Math.PI * 2);
      neonStroke(g, c, 6, 14);
      break;
    }
    case 'gem': {
      g.beginPath();
      g.moveTo(cx, cy - 40);
      g.lineTo(cx + 30, cy - 8);
      g.lineTo(cx, cy + 40);
      g.lineTo(cx - 30, cy - 8);
      g.closePath();
      neonFill(g, c, cx, cy, 40, 0.6, 0.25);
      neonStroke(g, c, 4, 14);
      g.beginPath();
      g.moveTo(cx - 30, cy - 8);
      g.lineTo(cx + 30, cy - 8);
      g.moveTo(cx - 12, cy - 8);
      g.lineTo(cx, cy + 40);
      g.lineTo(cx + 12, cy - 8);
      g.moveTo(cx - 12, cy - 8);
      g.lineTo(cx, cy - 40);
      g.lineTo(cx + 12, cy - 8);
      g.strokeStyle = css(lighten(c, 0.6), 0.7);
      g.lineWidth = 2;
      g.stroke();
      break;
    }
    case 'core':
    case 'core-unstable': {
      const unstable = key === 'core-unstable';
      poly(g, cx, cy, 6, 42, 0);
      neonFill(g, c, cx, cy, 42, 0.3, 0.1);
      neonStroke(g, c, 4, 14);
      // the energy ball inside
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, 24);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(0.45, css(lighten(c, 0.4)));
      gr.addColorStop(1, css(c, 0));
      g.fillStyle = gr;
      g.beginPath();
      g.arc(cx, cy, 24, 0, Math.PI * 2);
      g.fill();
      if (unstable) {
        // jagged crack lines
        g.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3 + 0.3;
          g.moveTo(cx + Math.cos(a) * 12, cy + Math.sin(a) * 12);
          g.lineTo(cx + Math.cos(a + 0.25) * 24, cy + Math.sin(a + 0.25) * 24);
          g.lineTo(cx + Math.cos(a - 0.1) * 36, cy + Math.sin(a - 0.1) * 36);
        }
        g.strokeStyle = 'rgba(255,255,255,0.85)';
        g.lineWidth = 2.5;
        g.stroke();
      }
      break;
    }
    case 'spike': {
      // red spiky ring: 12 spikes around a hollow ring
      g.beginPath();
      const n = 12;
      for (let i = 0; i < n * 2; i++) {
        const r = i % 2 === 0 ? 50 : 34;
        const a = (i * Math.PI) / n;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      neonFill(g, c, cx, cy, 50, 0.35, 0.15);
      neonStroke(g, c, 3.5, 14);
      g.beginPath();
      g.arc(cx, cy, 20, 0, Math.PI * 2);
      neonStroke(g, c, 3, 10);
      g.beginPath();
      g.arc(cx, cy, 8, 0, Math.PI * 2);
      g.fillStyle = css(lighten(c, 0.6));
      g.fill();
      break;
    }
    case 'laser': {
      // emitter node: a diamond with a bright eye
      poly(g, cx, cy, 4, 30, 0);
      neonFill(g, c, cx, cy, 30, 0.45, 0.2);
      neonStroke(g, c, 4, 12);
      g.beginPath();
      g.arc(cx, cy, 9, 0, Math.PI * 2);
      g.fillStyle = '#ffffff';
      g.shadowColor = css(c);
      g.shadowBlur = 14;
      g.fill();
      break;
    }
    case 'boost': {
      roundRect(g, 14, 30, 100, 68, 16);
      neonFill(g, c, cx, cy, 60, 0.22, 0.08);
      neonStroke(g, c, 3.5, 12);
      break;
    }
    case 'base': {
      poly(g, cx, cy, 6, 50, 0);
      neonFill(g, c, cx, cy, 50, 0.22, 0.06);
      neonStroke(g, c, 4, 14);
      poly(g, cx, cy, 6, 34, 0);
      g.setLineDash([8, 7]);
      neonStroke(g, c, 2, 6);
      g.setLineDash([]);
      break;
    }
    case 'tile': {
      roundRect(g, 10, 10, 108, 108, 14);
      neonFill(g, c, cx, cy, 70, 0.32, 0.14);
      neonStroke(g, c, 3, 9);
      break;
    }
    case 'hole': {
      g.beginPath();
      g.arc(cx, cy, 48, 0, Math.PI * 2);
      g.fillStyle = '#000000';
      g.fill();
      neonStroke(g, c, 3.5, 16);
      const gr = g.createRadialGradient(cx, cy, 20, cx, cy, 48);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(1, css(c, 0.35));
      g.fillStyle = gr;
      g.fill();
      break;
    }
    case 'finish': {
      // checkered neon strip: two columns of glowing squares
      const sq = 16;
      for (let y = 0; y < S; y += sq) {
        for (let col = 0; col < 2; col++) {
          if (((y / sq) + col) % 2 === 0) {
            g.fillStyle = '#ffffff';
            g.shadowColor = css(c);
            g.shadowBlur = 8;
            g.fillRect(cx - sq + col * sq + 1, y + 1, sq - 2, sq - 2);
          }
        }
      }
      g.shadowBlur = 0;
      g.beginPath();
      g.moveTo(cx - sq - 4, 0);
      g.lineTo(cx - sq - 4, S);
      g.moveTo(cx + sq + 4, 0);
      g.lineTo(cx + sq + 4, S);
      neonStroke(g, c, 2.5, 8);
      break;
    }
  }
  return cv;
}

/**
 * A selfie / avatar picture clipped to a circle inside a glowing ring in the player's colour
 * (never cropped to a square: the face sits whole inside the ring).
 */
export function drawPortrait(src: CanvasImageSource & { width: number; height: number }, c: number, look: LookId = 'neon'): HTMLCanvasElement {
  if (look === 'retro') return pixelPortrait(src, c);
  const cv = canvas(S, S), g = cv.getContext('2d')!;
  const cx = S / 2, cy = S / 2, r = 44;
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = css(NEON.bg);
  g.fill();
  g.clip();
  const k = Math.max((r * 2) / src.width, (r * 2) / src.height);
  const w = src.width * k, h = src.height * k;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, cx - w / 2, cy - h / 2, w, h);
  g.restore();
  g.beginPath();
  g.arc(cx, cy, r + 2, 0, Math.PI * 2);
  if (look === 'toybox') {
    // a chunky plastic frame: white rim inside a coloured bezel
    g.strokeStyle = '#ffffff';
    g.lineWidth = 6;
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, r + 7, 0, Math.PI * 2);
    g.strokeStyle = css(c);
    g.lineWidth = 7;
    g.stroke();
  } else if (look === 'cosmos') {
    // a helmet glass: soft colour rim and a reflection streak
    g.strokeStyle = '#d9def0';
    g.lineWidth = 6;
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, r + 2, 0, Math.PI * 2);
    neonStroke(g, c, 2.5, 12);
    g.beginPath();
    g.ellipse(cx - 18, cy - 24, 14, 5, -0.6, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fill();
  } else neonStroke(g, c, 5, 16);
  return cv;
}

/** Retro selfie: the face crushed to 14 px and a 1 px outline, kept pixel-sharp. */
function pixelPortrait(src: CanvasImageSource & { width: number; height: number }, c: number): HTMLCanvasElement {
  const N = 16, r = 7;
  const cv = canvas(N, N), g = cv.getContext('2d')!;
  g.save();
  g.beginPath();
  g.arc(N / 2, N / 2, r, 0, Math.PI * 2);
  g.clip();
  const k = Math.max((r * 2) / src.width, (r * 2) / src.height);
  g.imageSmoothingEnabled = true;
  g.drawImage(src, N / 2 - (src.width * k) / 2, N / 2 - (src.height * k) / 2, src.width * k, src.height * k);
  g.restore();
  // hard alpha (no half-transparent edge pixels) and a ring in the player's colour
  const d = g.getImageData(0, 0, N, N);
  for (let i = 3; i < d.data.length; i += 4) d.data[i] = d.data[i]! > 110 ? 255 : 0;
  g.putImageData(d, 0, 0);
  g.fillStyle = css(c);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dd = Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2);
    if (dd > r - 0.2 && dd <= r + 1) g.fillRect(x, y, 1, 1);
  }
  return cv;
}

/** Lazily drawn neon textures, cached per key and tint (a handful of colours per game). */
export class NeonArt {
  private cache = new Map<string, Texture>();
  private portraits = new Map<string, Texture>();
  /** Which art direction draws (round R2: neon, toybox, cosmos, retro). */
  look: LookId = 'neon';

  /** Switch the art direction (a new game): drops every cached sprite of the old look. */
  setLook(look: LookId): void {
    if (look === this.look) return;
    this.look = look;
    for (const t of this.cache.values()) t.destroy(true);
    this.cache.clear();
    this.clearPortraits();
  }

  /** Colours, player hues and switches of the current look. */
  get L() {
    return LOOKS[this.look];
  }

  get(key: ArtKey, color: number): Texture {
    const k = `${key}|${color}`;
    let t = this.cache.get(k);
    if (!t) {
      const cv = this.look === 'neon'
        ? drawNeonProp(key, color) ?? drawNeon(key === 'debris' ? 'gem' : (key as NeonKey | 'beam' | 'eye' | 'ring'), color)
        : drawLook(this.look, key, color);
      t = Texture.from(cv);
      if (this.L.pixel) t.source.scaleMode = 'nearest';
      this.cache.set(k, t);
    }
    return t;
  }

  /** Ring portrait of a loaded avatar texture; undefined if the texture has no drawable source. */
  portrait(id: string, tex: Texture, color: number): Texture | undefined {
    const k = `${id}|${color}`;
    let t = this.portraits.get(k);
    if (t) return t;
    const res = (tex.source as unknown as { resource?: unknown }).resource as (CanvasImageSource & { width: number; height: number }) | undefined;
    if (!res || !res.width) return undefined;
    t = Texture.from(drawPortrait(res, color, this.look));
    if (this.L.pixel) t.source.scaleMode = 'nearest';
    this.portraits.set(k, t);
    return t;
  }

  /** Drop portraits (new game: selfies belong to the previous room). */
  clearPortraits(): void {
    for (const t of this.portraits.values()) t.destroy(true);
    this.portraits.clear();
  }

  destroy(): void {
    for (const t of this.cache.values()) t.destroy(true);
    this.cache.clear();
    this.clearPortraits();
  }
}
