/**
 * Procedural sprites for the toybox, cosmos and retro looks, plus the physics prop keys
 * (ball, crate, bumper, barrel, goal net) for every look. Same canvas layout as the neon set
 * (128 px, art centred, the player body ~80 px across) so the entity layer sizes them all the
 * same way. Everything is drawn once per key and colour and cached (NeonArt).
 *
 * Retro sprites are drawn on a tiny grid (16 px) and keep nearest filtering: the pixels stay
 * square when the world scales them up.
 */
import { darken, lighten, mix } from './theme';
import type { LookId } from './looks';

export type ArtKey =
  | 'player' | 'gem' | 'core' | 'core-unstable' | 'spike' | 'laser' | 'boost' | 'base' | 'tile' | 'hole' | 'finish'
  | 'ball' | 'crate' | 'bumper' | 'barrel' | 'goal' | 'beam' | 'eye' | 'ring' | 'debris';

const S = 128;
const TAU = Math.PI * 2;

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function css(n: number, a = 1): string {
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
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

function circle(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
}

function poly(g: CanvasRenderingContext2D, cx: number, cy: number, n: number, r: number, rot = -Math.PI / 2): void {
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot + (i * TAU) / n;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

function star(g: CanvasRenderingContext2D, cx: number, cy: number, n: number, r0: number, r1: number, rot = -Math.PI / 2): void {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? r0 : r1;
    const a = rot + (i * Math.PI) / n;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

/** Superellipse body (the same silhouette family as the neon squircle, a little softer). */
function blob(g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, p = 0.62): void {
  g.beginPath();
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * TAU;
    const c = Math.cos(a), s = Math.sin(a);
    const x = cx + Math.sign(c) * Math.pow(Math.abs(c), p) * rx;
    const y = cy + Math.sign(s) * Math.pow(Math.abs(s), p) * ry;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

// ================================================================== toybox: glossy vinyl

/** Glossy plastic fill of the current path: lit from the top left, rim shade, bounce light. */
function plastic(g: CanvasRenderingContext2D, c: number, cx: number, cy: number, r: number, rim = 3): void {
  const gr = g.createRadialGradient(cx - r * 0.35, cy - r * 0.45, r * 0.05, cx, cy, r * 1.15);
  gr.addColorStop(0, css(lighten(c, 0.5)));
  gr.addColorStop(0.35, css(lighten(c, 0.12)));
  gr.addColorStop(0.8, css(c));
  gr.addColorStop(1, css(darken(c, 0.3)));
  g.fillStyle = gr;
  g.fill();
  if (rim > 0) {
    g.strokeStyle = css(darken(c, 0.42), 0.9);
    g.lineWidth = rim;
    g.stroke();
  }
}

/** The specular streak and a small glint that make plastic read as plastic. */
function gloss(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, a = 0.85): void {
  g.save();
  g.beginPath();
  g.ellipse(cx - r * 0.32, cy - r * 0.5, r * 0.42, r * 0.17, -0.42, 0, TAU);
  const gr = g.createLinearGradient(cx - r * 0.6, cy - r * 0.7, cx, cy - r * 0.3);
  gr.addColorStop(0, `rgba(255,255,255,${a})`);
  gr.addColorStop(1, 'rgba(255,255,255,0.15)');
  g.fillStyle = gr;
  g.fill();
  circle(g, cx + r * 0.38, cy - r * 0.42, r * 0.07);
  g.fillStyle = `rgba(255,255,255,${a * 0.8})`;
  g.fill();
  g.restore();
}

/** Soft bounce light along the lower rim. */
function bounce(g: CanvasRenderingContext2D, c: number, cx: number, cy: number, r: number): void {
  g.save();
  g.beginPath();
  g.ellipse(cx + r * 0.1, cy + r * 0.62, r * 0.55, r * 0.16, 0.15, 0, TAU);
  g.fillStyle = css(lighten(c, 0.45), 0.35);
  g.fill();
  g.restore();
}

function drawToy(key: ArtKey, c: number): HTMLCanvasElement {
  if (key === 'beam') {
    const cv = canvas(4, 64), g = cv.getContext('2d')!;
    const gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, css(c, 0));
    gr.addColorStop(0.36, css(darken(c, 0.2), 0.95));
    gr.addColorStop(0.46, css(lighten(c, 0.35)));
    gr.addColorStop(0.5, css(0xffffff));
    gr.addColorStop(0.58, css(c));
    gr.addColorStop(0.66, css(darken(c, 0.3), 0.95));
    gr.addColorStop(1, css(c, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 4, 64);
    return cv;
  }
  const cv = canvas(S, S), g = cv.getContext('2d')!;
  const cx = S / 2, cy = S / 2;
  switch (key) {
    case 'player': {
      blob(g, cx, cy + 2, 40, 38);
      plastic(g, c, cx, cy + 2, 40, 3.5);
      bounce(g, c, cx, cy + 2, 40);
      gloss(g, cx, cy + 2, 40);
      break;
    }
    case 'eye': {
      g.beginPath();
      g.ellipse(cx, cy, 30, 38, 0, 0, TAU);
      const gr = g.createLinearGradient(0, cy - 38, 0, cy + 38);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(1, '#e4e2f0');
      g.fillStyle = gr;
      g.fill();
      g.strokeStyle = 'rgba(27,20,51,0.55)';
      g.lineWidth = 4;
      g.stroke();
      break;
    }
    case 'ring':
      circle(g, cx, cy, 50);
      g.strokeStyle = css(c);
      g.lineWidth = 7;
      g.stroke();
      break;
    case 'gem': {
      // a cut candy gem: facets in three shades and a hard glint
      const top = cy - 38, mid = cy - 8, bot = cy + 40;
      const facet = (pts: number[], col: number) => {
        g.beginPath();
        g.moveTo(pts[0]!, pts[1]!);
        for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i]!, pts[i + 1]!);
        g.closePath();
        g.fillStyle = css(col);
        g.fill();
      };
      facet([cx - 32, mid, cx - 14, top, cx + 14, top, cx + 32, mid], lighten(c, 0.35));
      facet([cx - 32, mid, cx, bot, cx - 12, mid], darken(c, 0.05));
      facet([cx - 12, mid, cx, bot, cx + 12, mid], lighten(c, 0.15));
      facet([cx + 12, mid, cx, bot, cx + 32, mid], darken(c, 0.25));
      facet([cx - 14, top, cx - 4, mid, cx + 4, mid, cx + 14, top], lighten(c, 0.6));
      g.beginPath();
      g.moveTo(cx - 32, mid);
      g.lineTo(cx - 14, top);
      g.lineTo(cx + 14, top);
      g.lineTo(cx + 32, mid);
      g.lineTo(cx, bot);
      g.closePath();
      g.strokeStyle = css(darken(c, 0.45));
      g.lineWidth = 3;
      g.lineJoin = 'round';
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.ellipse(cx - 12, top + 9, 6, 3, -0.4, 0, TAU);
      g.fill();
      break;
    }
    case 'core':
    case 'core-unstable': {
      const unstable = key === 'core-unstable';
      circle(g, cx, cy, 34);
      plastic(g, c, cx, cy, 34, 3);
      if (unstable) {
        // warning band and a fuse cap
        g.save();
        circle(g, cx, cy, 34);
        g.clip();
        g.fillStyle = '#ffd23a';
        g.fillRect(cx - 40, cy + 6, 80, 12);
        g.fillStyle = '#241a3d';
        for (let x = -40; x < 40; x += 12) {
          g.beginPath();
          g.moveTo(cx + x, cy + 18);
          g.lineTo(cx + x + 6, cy + 6);
          g.lineTo(cx + x + 11, cy + 6);
          g.lineTo(cx + x + 5, cy + 18);
          g.closePath();
          g.fill();
        }
        g.restore();
        rr(g, cx - 7, cy - 46, 14, 14, 4);
        g.fillStyle = '#5b5670';
        g.fill();
      } else {
        // a marble swirl
        g.beginPath();
        g.arc(cx + 4, cy + 4, 18, 0.4, 2.6);
        g.strokeStyle = css(lighten(c, 0.55), 0.8);
        g.lineWidth = 6;
        g.lineCap = 'round';
        g.stroke();
      }
      gloss(g, cx, cy, 34);
      break;
    }
    case 'spike': {
      star(g, cx, cy, 10, 50, 32);
      plastic(g, c, cx, cy, 50, 3);
      circle(g, cx, cy, 20);
      plastic(g, lighten(c, 0.15), cx, cy, 20, 2.5);
      gloss(g, cx, cy, 44, 0.7);
      break;
    }
    case 'laser': {
      rr(g, cx - 26, cy - 26, 52, 52, 14);
      plastic(g, 0x8f8aa8, cx, cy, 30, 3);
      circle(g, cx, cy, 14);
      plastic(g, c, cx, cy, 14, 2.5);
      gloss(g, cx, cy, 26, 0.6);
      break;
    }
    case 'boost': {
      rr(g, 12, 28, 104, 72, 22);
      plastic(g, c, cx, cy, 60, 4);
      rr(g, 22, 38, 84, 52, 16);
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.lineWidth = 3;
      g.stroke();
      break;
    }
    case 'base': {
      poly(g, cx, cy, 6, 52, 0);
      g.fillStyle = css(c, 0.28);
      g.fill();
      g.strokeStyle = css(c);
      g.lineWidth = 6;
      g.lineJoin = 'round';
      g.stroke();
      poly(g, cx, cy, 6, 38, 0);
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.lineWidth = 3;
      g.stroke();
      break;
    }
    case 'tile': {
      // a light plastic floor tile (white art, tinted per frame) with a bevel
      rr(g, 6, 6, 116, 116, 18);
      g.fillStyle = '#c9c6d8';
      g.fill();
      rr(g, 6, 6, 116, 108, 18);
      const gr = g.createLinearGradient(0, 6, 0, 114);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(1, '#ebe9f4');
      g.fillStyle = gr;
      g.fill();
      rr(g, 16, 14, 96, 30, 12);
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fill();
      break;
    }
    case 'hole': {
      circle(g, cx, cy, 50);
      const gr = g.createRadialGradient(cx, cy + 10, 6, cx, cy, 50);
      gr.addColorStop(0, '#120c24');
      gr.addColorStop(0.75, '#241a3d');
      gr.addColorStop(1, '#4a3d6e');
      g.fillStyle = gr;
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.75)';
      g.lineWidth = 4;
      g.stroke();
      break;
    }
    case 'finish': {
      const sq = 16;
      for (let y = 0; y < S; y += sq) for (let col = 0; col < 2; col++) {
        g.fillStyle = ((y / sq) + col) % 2 === 0 ? '#ffffff' : '#241a3d';
        g.fillRect(cx - sq + col * sq, y, sq, sq);
      }
      break;
    }
    case 'ball': {
      // a glossy two-tone ball: white with three coloured panels (spin reads clearly)
      circle(g, cx, cy, 40);
      plastic(g, 0xf4f3fa, cx, cy, 40, 0);
      g.save();
      circle(g, cx, cy, 40);
      g.clip();
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * TAU) / 3;
        g.beginPath();
        g.moveTo(cx, cy);
        g.arc(cx, cy, 44, a - 0.42, a + 0.42);
        g.closePath();
        g.fillStyle = css(i === 1 ? lighten(c, 0.1) : c, 0.95);
        g.fill();
      }
      circle(g, cx, cy, 9);
      g.fillStyle = '#ffffff';
      g.fill();
      // shade over the panels so the whole ball reads round
      const sh = g.createRadialGradient(cx - 14, cy - 16, 6, cx, cy, 44);
      sh.addColorStop(0, 'rgba(255,255,255,0.25)');
      sh.addColorStop(0.7, 'rgba(0,0,0,0)');
      sh.addColorStop(1, 'rgba(20,10,40,0.35)');
      g.fillStyle = sh;
      g.fillRect(0, 0, S, S);
      g.restore();
      circle(g, cx, cy, 40);
      g.strokeStyle = css(darken(c, 0.5), 0.75);
      g.lineWidth = 3;
      g.stroke();
      gloss(g, cx, cy, 40);
      break;
    }
    case 'crate': {
      // a toy brick seen from above: bevelled block and four studs
      rr(g, 14, 16, 100, 100, 16);
      g.fillStyle = css(darken(c, 0.38));
      g.fill();
      rr(g, 14, 12, 100, 98, 16);
      const gr = g.createLinearGradient(14, 12, 114, 110);
      gr.addColorStop(0, css(lighten(c, 0.3)));
      gr.addColorStop(1, css(darken(c, 0.08)));
      g.fillStyle = gr;
      g.fill();
      g.strokeStyle = css(darken(c, 0.4), 0.8);
      g.lineWidth = 3;
      g.stroke();
      for (const [sx, sy] of [[44, 42], [84, 42], [44, 80], [84, 80]] as const) {
        circle(g, sx, sy + 3, 13);
        g.fillStyle = css(darken(c, 0.3));
        g.fill();
        circle(g, sx, sy, 13);
        plastic(g, lighten(c, 0.08), sx, sy, 13, 0);
        g.beginPath();
        g.ellipse(sx - 4, sy - 5, 5, 2.5, -0.5, 0, TAU);
        g.fillStyle = 'rgba(255,255,255,0.7)';
        g.fill();
      }
      break;
    }
    case 'bumper': {
      // pinball mushroom bumper: white skirt, coloured cap, star in the middle
      circle(g, cx, cy + 4, 52);
      g.fillStyle = 'rgba(30,20,60,0.25)';
      g.fill();
      circle(g, cx, cy, 52);
      plastic(g, 0xf2f0fa, cx, cy, 52, 3);
      circle(g, cx, cy, 38);
      plastic(g, c, cx, cy, 38, 3);
      star(g, cx, cy, 5, 18, 8);
      g.fillStyle = '#ffffff';
      g.fill();
      gloss(g, cx, cy, 38, 0.75);
      break;
    }
    case 'barrel': {
      // an explosive barrel from above: red drum, two steel hoops, a warning badge
      circle(g, cx, cy, 44);
      plastic(g, c, cx, cy, 44, 3);
      for (const r of [36, 24]) {
        circle(g, cx, cy, r);
        g.strokeStyle = css(darken(c, 0.35));
        g.lineWidth = 4;
        g.stroke();
      }
      poly(g, cx, cy + 2, 3, 17);
      g.fillStyle = '#ffd23a';
      g.fill();
      g.strokeStyle = '#241a3d';
      g.lineWidth = 3;
      g.lineJoin = 'round';
      g.stroke();
      g.fillStyle = '#241a3d';
      g.fillRect(cx - 1.8, cy - 6, 3.6, 8);
      g.fillRect(cx - 1.8, cy + 5, 3.6, 3.6);
      gloss(g, cx, cy, 44, 0.65);
      break;
    }
    case 'goal': {
      // net goal, mouth open to +x: white posts, a fine net
      g.save();
      rr(g, 14, 14, 100, 100, 10);
      g.clip();
      g.fillStyle = 'rgba(255,255,255,0.16)';
      g.fillRect(0, 0, S, S);
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.lineWidth = 1.6;
      for (let i = 14; i <= 114; i += 10) {
        g.beginPath();
        g.moveTo(i, 14);
        g.lineTo(i, 114);
        g.moveTo(14, i);
        g.lineTo(114, i);
        g.stroke();
      }
      g.restore();
      g.beginPath();
      g.moveTo(118, 12);
      g.lineTo(18, 12);
      g.arcTo(10, 12, 10, 20, 8);
      g.lineTo(10, 108);
      g.arcTo(10, 116, 18, 116, 8);
      g.lineTo(118, 116);
      g.strokeStyle = 'rgba(36,26,61,0.35)';
      g.lineWidth = 12;
      g.lineCap = 'round';
      g.stroke();
      g.strokeStyle = '#ffffff';
      g.lineWidth = 8;
      g.stroke();
      circle(g, 118, 12, 8);
      g.fillStyle = css(c);
      g.fill();
      circle(g, 118, 116, 8);
      g.fill();
      break;
    }
    case 'debris': {
      rr(g, 40, 44, 48, 40, 8);
      plastic(g, c, cx, cy, 30, 2.5);
      break;
    }
  }
  return cv;
}

// ================================================================== cosmos: deep space

function halo(g: CanvasRenderingContext2D, c: number, cx: number, cy: number, r0: number, r1: number, a = 0.5): void {
  const gr = g.createRadialGradient(cx, cy, r0, cx, cy, r1);
  gr.addColorStop(0, css(c, a));
  gr.addColorStop(1, css(c, 0));
  g.fillStyle = gr;
  g.fillRect(cx - r1, cy - r1, r1 * 2, r1 * 2);
}

/** Lit sphere: soft key light top-left, terminator shade bottom-right, thin atmosphere rim. */
function sphere(g: CanvasRenderingContext2D, c: number, cx: number, cy: number, r: number, rim = 0x9fd8ff): void {
  circle(g, cx, cy, r);
  const gr = g.createRadialGradient(cx - r * 0.4, cy - r * 0.45, r * 0.05, cx, cy, r);
  gr.addColorStop(0, css(lighten(c, 0.55)));
  gr.addColorStop(0.45, css(c));
  gr.addColorStop(1, css(darken(c, 0.62)));
  g.fillStyle = gr;
  g.fill();
  g.strokeStyle = css(rim, 0.55);
  g.lineWidth = 2;
  g.stroke();
}

function drawCosmos(key: ArtKey, c: number): HTMLCanvasElement {
  if (key === 'beam') {
    const cv = canvas(4, 64), g = cv.getContext('2d')!;
    const gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, css(c, 0));
    gr.addColorStop(0.32, css(c, 0.25));
    gr.addColorStop(0.46, css(lighten(c, 0.3), 0.9));
    gr.addColorStop(0.5, css(0xffffff));
    gr.addColorStop(0.54, css(lighten(c, 0.3), 0.9));
    gr.addColorStop(0.68, css(c, 0.25));
    gr.addColorStop(1, css(c, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 4, 64);
    return cv;
  }
  const cv = canvas(S, S), g = cv.getContext('2d')!;
  const cx = S / 2, cy = S / 2;
  switch (key) {
    case 'player': {
      // astronaut orb: suit sphere in the player colour, helmet seal, dark glass visor
      halo(g, c, cx, cy + 2, 30, 62, 0.4);
      sphere(g, mix(c, 0xe8ecff, 0.25), cx, cy + 2, 41, lighten(c, 0.5));
      // backpack hint and side lamps
      g.beginPath();
      g.ellipse(cx, cy + 30, 18, 6, 0, 0, TAU);
      g.fillStyle = css(darken(c, 0.55), 0.6);
      g.fill();
      // helmet seal ring
      g.beginPath();
      g.ellipse(cx, cy - 6, 33, 24, 0, 0, TAU);
      g.fillStyle = '#d9def0';
      g.fill();
      g.strokeStyle = 'rgba(40,46,80,0.6)';
      g.lineWidth = 2;
      g.stroke();
      // visor
      g.beginPath();
      g.ellipse(cx, cy - 6, 29, 20, 0, 0, TAU);
      const vg = g.createLinearGradient(0, cy - 26, 0, cy + 14);
      vg.addColorStop(0, '#2a3470');
      vg.addColorStop(0.55, '#0b1030');
      vg.addColorStop(1, '#050817');
      g.fillStyle = vg;
      g.fill();
      // visor reflections: a coloured horizon arc and a hard white streak
      g.save();
      g.beginPath();
      g.ellipse(cx, cy - 6, 29, 20, 0, 0, TAU);
      g.clip();
      g.beginPath();
      g.ellipse(cx + 4, cy + 18, 40, 16, 0, Math.PI, TAU);
      g.strokeStyle = css(c, 0.55);
      g.lineWidth = 3;
      g.stroke();
      g.beginPath();
      g.ellipse(cx - 13, cy - 17, 11, 4, -0.35, 0, TAU);
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.fill();
      g.restore();
      break;
    }
    case 'eye': {
      // glowing visor eyes (no pupils in this look)
      g.beginPath();
      g.ellipse(cx, cy, 22, 30, 0, 0, TAU);
      g.fillStyle = '#ffffff';
      g.shadowColor = 'rgba(140,230,255,0.95)';
      g.shadowBlur = 22;
      g.fill();
      g.fill();
      break;
    }
    case 'ring':
      circle(g, cx, cy, 50);
      g.strokeStyle = css(c);
      g.lineWidth = 5;
      g.shadowColor = css(c);
      g.shadowBlur = 12;
      g.stroke();
      break;
    case 'gem': {
      // a long crystal shard with an inner light
      halo(g, c, cx, cy, 8, 56, 0.45);
      g.beginPath();
      g.moveTo(cx, cy - 46);
      g.lineTo(cx + 16, cy - 22);
      g.lineTo(cx + 12, cy + 34);
      g.lineTo(cx, cy + 46);
      g.lineTo(cx - 12, cy + 34);
      g.lineTo(cx - 16, cy - 22);
      g.closePath();
      const gr = g.createLinearGradient(cx - 16, 0, cx + 16, 0);
      gr.addColorStop(0, css(lighten(c, 0.55), 0.95));
      gr.addColorStop(0.5, css(c, 0.9));
      gr.addColorStop(1, css(darken(c, 0.35), 0.95));
      g.fillStyle = gr;
      g.fill();
      g.strokeStyle = css(lighten(c, 0.7));
      g.lineWidth = 1.5;
      g.stroke();
      g.beginPath();
      g.moveTo(cx, cy - 46);
      g.lineTo(cx, cy + 46);
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.stroke();
      break;
    }
    case 'core':
    case 'core-unstable': {
      const unstable = key === 'core-unstable';
      // a tiny star: corona, hot core, flare spikes
      halo(g, c, cx, cy, 10, 62, 0.65);
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < (unstable ? 8 : 4); i++) {
        const a = (i * TAU) / (unstable ? 8 : 4) + 0.3;
        g.beginPath();
        g.ellipse(cx, cy, unstable ? 54 : 50, 2.5, a, 0, TAU);
        g.fillStyle = css(lighten(c, 0.5), 0.55);
        g.fill();
      }
      g.restore();
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, 24);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(0.5, css(lighten(c, 0.45)));
      gr.addColorStop(1, css(c, 0.0));
      g.fillStyle = gr;
      circle(g, cx, cy, 24);
      g.fill();
      if (unstable) {
        circle(g, cx, cy, 30);
        g.setLineDash([6, 6]);
        g.strokeStyle = 'rgba(255,255,255,0.75)';
        g.lineWidth = 2;
        g.stroke();
        g.setLineDash([]);
      }
      break;
    }
    case 'spike': {
      // space mine: dark armoured sphere, studded spines, a red sensor eye
      for (let i = 0; i < 8; i++) {
        const a = (i * TAU) / 8;
        g.beginPath();
        g.moveTo(cx + Math.cos(a - 0.16) * 30, cy + Math.sin(a - 0.16) * 30);
        g.lineTo(cx + Math.cos(a) * 52, cy + Math.sin(a) * 52);
        g.lineTo(cx + Math.cos(a + 0.16) * 30, cy + Math.sin(a + 0.16) * 30);
        g.closePath();
        g.fillStyle = '#6c7391';
        g.fill();
        circle(g, cx + Math.cos(a) * 51, cy + Math.sin(a) * 51, 3.5);
        g.fillStyle = css(c);
        g.fill();
      }
      sphere(g, 0x3a4060, cx, cy, 34, 0x8a93b8);
      halo(g, c, cx, cy, 2, 20, 0.9);
      circle(g, cx, cy, 7);
      g.fillStyle = '#ffffff';
      g.fill();
      break;
    }
    case 'laser': {
      halo(g, c, cx, cy, 4, 40, 0.5);
      poly(g, cx, cy, 6, 24, 0);
      g.fillStyle = '#2a3150';
      g.fill();
      g.strokeStyle = '#8a93b8';
      g.lineWidth = 3;
      g.stroke();
      circle(g, cx, cy, 9);
      g.fillStyle = '#ffffff';
      g.shadowColor = css(c);
      g.shadowBlur = 16;
      g.fill();
      break;
    }
    case 'boost': {
      // warp pad: an elongated ring stack
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.ellipse(cx, cy, 54 - i * 14, 30 - i * 8, 0, 0, TAU);
        g.strokeStyle = css(c, 0.35 + i * 0.25);
        g.lineWidth = 3;
        g.shadowColor = css(c);
        g.shadowBlur = 10;
        g.stroke();
      }
      break;
    }
    case 'base': {
      // docking ring
      circle(g, cx, cy, 52);
      g.fillStyle = css(c, 0.12);
      g.fill();
      g.lineWidth = 4;
      g.strokeStyle = css(c, 0.9);
      g.shadowColor = css(c);
      g.shadowBlur = 14;
      g.stroke();
      g.shadowBlur = 0;
      for (let i = 0; i < 12; i++) {
        const a = (i * TAU) / 12;
        g.fillStyle = css(lighten(c, 0.5), 0.9);
        g.fillRect(cx + Math.cos(a) * 42 - 2, cy + Math.sin(a) * 42 - 2, 4, 4);
      }
      break;
    }
    case 'tile': {
      // dark glass deck panel (white art: tinted per frame)
      rr(g, 8, 8, 112, 112, 10);
      const gr = g.createLinearGradient(0, 8, 0, 120);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)');
      gr.addColorStop(1, 'rgba(255,255,255,0.28)');
      g.fillStyle = gr;
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.lineWidth = 3;
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      for (const [x, y] of [[18, 18], [110, 18], [18, 110], [110, 110]] as const) g.fillRect(x - 2, y - 2, 4, 4);
      break;
    }
    case 'hole': {
      // black hole: accretion disc, event horizon
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.beginPath();
      g.ellipse(cx, cy, 58, 20, -0.35, 0, TAU);
      g.strokeStyle = 'rgba(255,170,90,0.6)';
      g.lineWidth = 6;
      g.shadowColor = 'rgba(255,140,80,1)';
      g.shadowBlur = 14;
      g.stroke();
      g.restore();
      halo(g, 0xc77dff, cx, cy, 20, 50, 0.6);
      circle(g, cx, cy, 26);
      g.fillStyle = '#000000';
      g.fill();
      g.strokeStyle = 'rgba(255,220,180,0.9)';
      g.lineWidth = 2;
      g.stroke();
      break;
    }
    case 'finish': {
      const sq = 16;
      for (let y = 0; y < S; y += sq) for (let col = 0; col < 2; col++) {
        if (((y / sq) + col) % 2 !== 0) continue;
        g.fillStyle = '#ffffff';
        g.shadowColor = css(c);
        g.shadowBlur = 10;
        g.fillRect(cx - sq + col * sq + 2, y + 2, sq - 4, sq - 4);
      }
      break;
    }
    case 'ball': {
      // a little moon: craters and a bright rim
      halo(g, c, cx, cy, 30, 58, 0.45);
      sphere(g, 0xc9cde3, cx, cy, 40, lighten(c, 0.4));
      g.save();
      circle(g, cx, cy, 40);
      g.clip();
      for (const [x, y, r] of [[-14, -10, 9], [12, 8, 12], [-6, 20, 6], [18, -18, 5], [-22, 10, 4]] as const) {
        circle(g, cx + x, cy + y, r);
        g.fillStyle = 'rgba(60,64,100,0.45)';
        g.fill();
        g.beginPath();
        g.arc(cx + x, cy + y, r, Math.PI * 0.15, Math.PI * 1.05);
        g.strokeStyle = 'rgba(255,255,255,0.45)';
        g.lineWidth = 1.5;
        g.stroke();
      }
      // a colour band so spin reads
      g.fillStyle = css(c, 0.5);
      g.fillRect(cx - 44, cy - 3, 88, 6);
      g.restore();
      break;
    }
    case 'crate': {
      // cargo pod: brushed metal, a coloured stripe, rivets
      rr(g, 16, 16, 96, 96, 10);
      const gr = g.createLinearGradient(16, 16, 112, 112);
      gr.addColorStop(0, '#b6bdd8');
      gr.addColorStop(1, '#5d6688');
      g.fillStyle = gr;
      g.fill();
      g.strokeStyle = '#2a3150';
      g.lineWidth = 3;
      g.stroke();
      rr(g, 28, 28, 72, 72, 6);
      g.strokeStyle = 'rgba(30,36,64,0.55)';
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = css(c);
      g.fillRect(16, 56, 96, 16);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(16, 56, 96, 3);
      g.fillStyle = '#e8ecff';
      for (const [x, y] of [[24, 24], [104, 24], [24, 104], [104, 104]] as const) {
        circle(g, x, y, 3);
        g.fill();
      }
      break;
    }
    case 'bumper': {
      // pulsar: a hot orb inside a bright ring
      halo(g, c, cx, cy, 20, 64, 0.55);
      circle(g, cx, cy, 44);
      g.strokeStyle = css(lighten(c, 0.4));
      g.lineWidth = 6;
      g.shadowColor = css(c);
      g.shadowBlur = 16;
      g.stroke();
      g.shadowBlur = 0;
      sphere(g, c, cx, cy, 28, lighten(c, 0.6));
      circle(g, cx, cy, 10);
      g.fillStyle = '#ffffff';
      g.fill();
      break;
    }
    case 'barrel': {
      // fuel canister: hazard stripes round a capped top
      circle(g, cx, cy, 42);
      g.fillStyle = '#2b2f45';
      g.fill();
      g.save();
      circle(g, cx, cy, 42);
      g.clip();
      for (let i = -6; i < 6; i++) {
        g.beginPath();
        g.moveTo(cx + i * 16, cy - 50);
        g.lineTo(cx + i * 16 + 8, cy - 50);
        g.lineTo(cx + i * 16 + 58, cy + 50);
        g.lineTo(cx + i * 16 + 50, cy + 50);
        g.closePath();
        g.fillStyle = css(c);
        g.fill();
      }
      g.restore();
      sphere(g, 0x8a93b8, cx, cy, 22, 0xffffff);
      circle(g, cx, cy, 8);
      g.fillStyle = css(c);
      g.shadowColor = css(c);
      g.shadowBlur = 12;
      g.fill();
      break;
    }
    case 'goal': {
      // a gate of light, mouth open to +x
      g.save();
      rr(g, 14, 14, 100, 100, 12);
      g.clip();
      const gr = g.createLinearGradient(14, 0, 118, 0);
      gr.addColorStop(0, css(c, 0.45));
      gr.addColorStop(1, css(c, 0.04));
      g.fillStyle = gr;
      g.fillRect(0, 0, S, S);
      g.restore();
      g.beginPath();
      g.moveTo(118, 12);
      g.lineTo(20, 12);
      g.arcTo(10, 12, 10, 22, 10);
      g.lineTo(10, 106);
      g.arcTo(10, 116, 20, 116, 10);
      g.lineTo(118, 116);
      g.strokeStyle = css(lighten(c, 0.5));
      g.lineWidth = 5;
      g.lineCap = 'round';
      g.shadowColor = css(c);
      g.shadowBlur = 14;
      g.stroke();
      break;
    }
    case 'debris': {
      g.beginPath();
      g.moveTo(cx - 20, cy - 14);
      g.lineTo(cx + 18, cy - 20);
      g.lineTo(cx + 22, cy + 12);
      g.lineTo(cx - 12, cy + 20);
      g.closePath();
      g.fillStyle = '#8a93b8';
      g.fill();
      g.strokeStyle = css(c);
      g.lineWidth = 3;
      g.stroke();
      break;
    }
  }
  return cv;
}

// ================================================================== retro: pixel art

/**
 * Pixel sprite from rows of characters: '.' clear, 'o' outline, 'c' colour, 'h' highlight,
 * 's' shade, 'w' white, 'k' black, 'y' yellow, 'r' red, 'g' grey. One char = one pixel.
 */
function pix(rows: string[], c: number): HTMLCanvasElement {
  const h = rows.length, w = rows[0]!.length;
  const cv = canvas(w, h), g = cv.getContext('2d')!;
  const map: Record<string, string> = {
    o: css(0x000000), c: css(c), h: css(lighten(c, 0.5)), s: css(darken(c, 0.4)), w: css(0xfff1e8), k: css(0x000000),
    y: css(0xffec27), r: css(0xff004d), g: css(0x5f574f), l: css(0xc2c3c7),
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ch = rows[y]![x]!;
    const f = map[ch];
    if (!f) continue;
    g.fillStyle = f;
    g.fillRect(x, y, 1, 1);
  }
  return cv;
}

const RETRO: Partial<Record<ArtKey, string[]>> = {
  // 16 x 16, body 10 px across (the same 0.625 share as the other looks)
  player: [
    '................',
    '................',
    '................',
    '.....oooooo.....',
    '....ohhcccco....',
    '...ohhcccccco...',
    '...ohwkcwkccso..',
    '...ocwkcwkccso..',
    '...occcccccsso..',
    '...occcccccsso..',
    '...occcccssso...',
    '....osssssso....',
    '.....oooooo.....',
    '................',
    '................',
    '................',
  ],
  gem: [
    '................',
    '................',
    '......oooo......',
    '.....ohhcco.....',
    '....ohhcccso....',
    '...ohhcccccso...',
    '...occcccccso...',
    '....occcccso....',
    '.....occcso.....',
    '......ocso......',
    '.......oo.......',
    '................',
  ],
  core: [
    '................',
    '.....oooooo.....',
    '....ohhwwcco....',
    '...ohwwccccco...',
    '...ohwccccccso..',
    '...occcccccsso..',
    '...occcccccsso..',
    '...occcccssss...',
    '....osssssso....',
    '.....oooooo.....',
    '................',
  ],
  'core-unstable': [
    '.......yy.......',
    '.......g........',
    '.....oooooo.....',
    '....ohhcccco....',
    '...ohhcwcccco...',
    '...occwcwccso...',
    '...occcwcccso...',
    '...occcccccso...',
    '...occcccssso...',
    '....osssssso....',
    '.....oooooo.....',
    '................',
  ],
  spike: [
    '.......o........',
    '...o..oco..o....',
    '....ooccco o....',
    '...occhccccoo...',
    '.ooccccccccco...',
    'occcccccccccsoo.',
    '..ocscccccssso..',
    '...ocsscsssso...',
    '...oo.osso.oo...',
    '..o....oo....o..',
  ],
  laser: [
    '..oooo..',
    '.ollllo.',
    'olwcclo.',
    'olcccgo.',
    'olcccgo.',
    '.oggggo.',
    '..oooo..',
    '........',
  ],
  ball: [
    '...oooo...',
    '.oowwwwoo.',
    '.owwkkwwlo',
    'owwwkkwwwo',
    'okwwwwwkko',
    'okkwwwwkko',
    'owwwkkwwlo',
    '.owwkkwwlo',
    '.oollllog.',
    '...oooo...',
  ],
  crate: [
    'oooooooooooo',
    'ohhhhhhhhhso',
    'ohcoccccocso',
    'ohcocccoscso',
    'ohccocosccso',
    'ohcccossccso',
    'ohccsocoscso',
    'ohcsoccocsso',
    'ohcoscccocso',
    'ohoscccccoso',
    'osssssssssso',
    'oooooooooooo',
  ],
  bumper: [
    '....oooo....',
    '..oowwwwoo..',
    '.owwccccwwo.',
    '.owcchhccwo.',
    'owcchwwhccwo',
    'owchwyywhcwo',
    'owchwyywhcwo',
    'owcchwwhccwo',
    '.owcchhccwo.',
    '.owwccccwwo.',
    '..oowwwwoo..',
    '....oooo....',
  ],
  barrel: [
    '...oooooo...',
    '..occcccco..',
    '.occhhcccco.',
    'occgggggggco',
    'occcyyyyccco',
    'occcykkyccco',
    'occcykkyccco',
    'occcyyyyccco',
    'occgggggggco',
    '.occccccsso.',
    '..osssssso..',
    '...oooooo...',
  ],
  finish: [
    'wwkk', 'wwkk', 'kkww', 'kkww', 'wwkk', 'wwkk', 'kkww', 'kkww',
    'wwkk', 'wwkk', 'kkww', 'kkww', 'wwkk', 'wwkk', 'kkww', 'kkww',
  ],
  debris: ['oooo', 'ochs', 'ocss', 'oooo'],
};

function drawRetro(key: ArtKey, c: number): HTMLCanvasElement {
  // the hand-typed rows above may contain look-alike characters; anything unknown is clear
  const rows = RETRO[key];
  if (rows) {
    const w = Math.max(...rows.map((r) => r.length));
    return pix(rows.map((r) => r.padEnd(w, '.')), c);
  }
  switch (key) {
    case 'beam': {
      const cv = canvas(1, 8), g = cv.getContext('2d')!;
      const col = ['', css(c, 0.5), css(c), css(0xfff1e8), css(0xfff1e8), css(c), css(c, 0.5), ''];
      col.forEach((f, i) => {
        if (!f) return;
        g.fillStyle = f;
        g.fillRect(0, i, 1, 1);
      });
      return cv;
    }
    case 'eye':
      return pix(['.ww.', 'wwww', 'wwww', '.ww.'], c);
    case 'ring':
      return pix(['..cccc..', '.c....c.', 'c......c', 'c......c', 'c......c', 'c......c', '.c....c.', '..cccc..'], c);
    case 'boost':
      return pix([
        '................', '.oooooooooooooo.', '.occcccccccccco.', '.occccccccccsco.', '.occccccccccsco.',
        '.occccccccccsco.', '.occccccccccsco.', '.osssssssssssso.', '.oooooooooooooo.', '................',
      ], c);
    case 'base':
      return pix([
        'cc.cc.cc.cc.cc.c', 'c..............c', '................', 'c..............c', 'c..............c', '................',
        'c..............c', 'c..............c', '................', 'c..............c', 'c..............c', '................',
        'c..............c', 'c..............c', '................', 'cc.cc.cc.cc.cc.c',
      ], c);
    case 'tile':
      return pix(['wwwwwwww', 'wllllllg', 'wllllllg', 'wllllllg', 'wllllllg', 'wllllllg', 'wllllllg', 'gggggggg'], c);
    case 'hole':
      return pix(['.gggggg.', 'gkkkkkkg', 'gkkkkkkg', 'gkkkkkkg', 'gkkkkkkg', 'gkkkkkkg', 'gkkkkkkg', '.gggggg.'], c);
    case 'goal':
      return pix([
        'wwwwwwwwwwwwwwww', 'wg.g.g.g.g.g.g.g', 'w...............', 'wg.g.g.g.g.g.g.g', 'w...............', 'wg.g.g.g.g.g.g.g',
        'w...............', 'wg.g.g.g.g.g.g.g', 'w...............', 'wg.g.g.g.g.g.g.g', 'w...............', 'wg.g.g.g.g.g.g.g',
        'w...............', 'wg.g.g.g.g.g.g.g', 'w...............', 'wwwwwwwwwwwwwwww',
      ], c);
    default:
      return pix(['cc', 'cc'], c);
  }
}

// ================================================================== neon physics props

function neonGlowStroke(g: CanvasRenderingContext2D, c: number, w: number, glow = 14): void {
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

function neonInner(g: CanvasRenderingContext2D, c: number, cx: number, cy: number, r: number, a0 = 0.42, a1 = 0.12): void {
  const gr = g.createRadialGradient(cx, cy - r * 0.2, r * 0.1, cx, cy, r);
  gr.addColorStop(0, css(lighten(c, 0.35), a0));
  gr.addColorStop(1, css(c, a1));
  g.fillStyle = gr;
  g.fill();
}

/** Neon versions of the physics props (the rest of the neon set lives in neon.ts). */
export function drawNeonProp(key: ArtKey, c: number): HTMLCanvasElement | undefined {
  const cv = canvas(S, S), g = cv.getContext('2d')!;
  const cx = S / 2, cy = S / 2;
  switch (key) {
    case 'ball':
      circle(g, cx, cy, 40);
      neonInner(g, c, cx, cy, 40, 0.5, 0.2);
      neonGlowStroke(g, c, 4.5, 16);
      g.beginPath();
      g.moveTo(cx - 40, cy);
      g.bezierCurveTo(cx - 14, cy - 18, cx + 14, cy + 18, cx + 40, cy);
      g.moveTo(cx, cy - 40);
      g.bezierCurveTo(cx + 16, cy - 14, cx - 16, cy + 14, cx, cy + 40);
      neonGlowStroke(g, c, 2, 6);
      return cv;
    case 'crate':
      rr(g, 20, 20, 88, 88, 8);
      neonInner(g, c, cx, cy, 60, 0.3, 0.1);
      neonGlowStroke(g, c, 4, 14);
      g.beginPath();
      g.moveTo(32, 32);
      g.lineTo(96, 96);
      g.moveTo(96, 32);
      g.lineTo(32, 96);
      neonGlowStroke(g, c, 2.5, 8);
      return cv;
    case 'bumper':
      for (const [r, w] of [[50, 4], [34, 3]] as const) {
        circle(g, cx, cy, r);
        if (r === 50) neonInner(g, c, cx, cy, r, 0.25, 0.08);
        neonGlowStroke(g, c, w, 14);
      }
      star(g, cx, cy, 5, 18, 8);
      g.fillStyle = '#ffffff';
      g.shadowColor = css(c);
      g.shadowBlur = 12;
      g.fill();
      return cv;
    case 'barrel':
      circle(g, cx, cy, 42);
      neonInner(g, c, cx, cy, 42, 0.45, 0.2);
      neonGlowStroke(g, c, 4, 14);
      circle(g, cx, cy, 28);
      neonGlowStroke(g, c, 2, 8);
      poly(g, cx, cy + 3, 3, 16);
      neonGlowStroke(g, 0xffb020, 2.5, 8);
      return cv;
    case 'goal':
      g.save();
      rr(g, 14, 14, 100, 100, 10);
      g.clip();
      g.strokeStyle = css(c, 0.3);
      g.lineWidth = 1.2;
      for (let i = 14; i <= 114; i += 10) {
        g.beginPath();
        g.moveTo(i, 14);
        g.lineTo(i, 114);
        g.moveTo(14, i);
        g.lineTo(114, i);
        g.stroke();
      }
      g.restore();
      g.beginPath();
      g.moveTo(118, 12);
      g.lineTo(18, 12);
      g.arcTo(10, 12, 10, 20, 8);
      g.lineTo(10, 108);
      g.arcTo(10, 116, 18, 116, 8);
      g.lineTo(118, 116);
      neonGlowStroke(g, c, 4, 14);
      return cv;
    case 'debris':
      g.beginPath();
      g.moveTo(cx - 18, cy - 14);
      g.lineTo(cx + 20, cy - 8);
      g.lineTo(cx + 6, cy + 18);
      g.closePath();
      neonGlowStroke(g, c, 3, 10);
      return cv;
    default:
      return undefined;
  }
}

/** Draw `key` in colour `c` for a non-neon look. */
export function drawLook(look: LookId, key: ArtKey, c: number): HTMLCanvasElement {
  if (look === 'toybox') return drawToy(key, c);
  if (look === 'cosmos') return drawCosmos(key, c);
  return drawRetro(key, c);
}
