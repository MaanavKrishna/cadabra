// Fallback key art: procedural SVG scenes per theme (no network, no AI), composed with a few
// sprites from the default art pack as hero characters. Rasterised once as a CSS background.
import { rootId } from './lineage';
import type { GameSpec } from '@cadabra/spec';
import { gameStill } from '../ui/hero';

type Pal = GameSpec['theme']['palette'];

export interface HeroSprite {
  /** Default art pack key (packages/render/assets/default/<key>.png). */
  key: string;
  /** Position in the 1920x1080 stage (centre, px) and width (px). */
  x: number;
  y: number;
  w: number;
  rot?: number;
  /** Behind the scrim (scenery) or in front (hero). */
  depth?: 'back' | 'front';
  float?: boolean;
}

export interface KeyArt {
  /** data:image/svg+xml URL of the 1920x1080 backdrop. */
  backdrop: string;
  sprites: HeroSprite[];
}

const svgUrl = (body: string, defs = '') =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice"><defs>${defs}</defs>${body}</svg>`,
  )}`;

/** Deterministic pseudo-random sequence for scatter (stars, embers). */
function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

function dots(n: number, seed: number, box: [number, number, number, number], r: [number, number], fill: string, op: [number, number]): string {
  const rnd = rand(seed);
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = box[0] + rnd() * (box[2] - box[0]);
    const y = box[1] + rnd() * (box[3] - box[1]);
    out += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(r[0] + rnd() * (r[1] - r[0])).toFixed(1)}" fill="${fill}" opacity="${(op[0] + rnd() * (op[1] - op[0])).toFixed(2)}"/>`;
  }
  return out;
}

function ladooHeist(p: Pal): KeyArt {
  const defs = `
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a2a18"/><stop offset="1" stop-color="${p.bg}"/></linearGradient>
    <radialGradient id="lamp" cx="0.68" cy="0.18" r="0.55"><stop offset="0" stop-color="${p.glow}" stop-opacity="0.75"/><stop offset="0.45" stop-color="${p.primary}" stop-opacity="0.22"/><stop offset="1" stop-color="${p.primary}" stop-opacity="0"/></radialGradient>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16224a"/><stop offset="1" stop-color="#2d3f7a"/></linearGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b2014"/><stop offset="1" stop-color="#1a0d07"/></linearGradient>
    <pattern id="tiles" width="96" height="96" patternUnits="userSpaceOnUse"><rect width="96" height="96" fill="none" stroke="#ffffff" stroke-opacity="0.05" stroke-width="3"/></pattern>`;
  const body = `
    <rect width="1920" height="1080" fill="url(#wall)"/>
    <rect width="1920" height="760" fill="url(#tiles)"/>
    <g transform="translate(1480 120)"><rect width="300" height="360" rx="24" fill="url(#sky)" stroke="#6b3f22" stroke-width="18"/>
      <circle cx="205" cy="105" r="48" fill="#fff6d8"/><circle cx="185" cy="95" r="48" fill="url(#sky)" opacity="0.0"/>
      <line x1="150" y1="0" x2="150" y2="360" stroke="#6b3f22" stroke-width="12"/><line x1="0" y1="180" x2="300" y2="180" stroke="#6b3f22" stroke-width="12"/>
      ${dots(14, 7, [10, 10, 290, 170], [1.5, 3.5], '#ffffff', [0.4, 0.9])}</g>
    <rect width="1920" height="1080" fill="url(#lamp)"/>
    <line x1="1300" y1="0" x2="1300" y2="150" stroke="#2a160c" stroke-width="8"/>
    <path d="M1230 150 L1370 150 L1410 230 L1190 230 Z" fill="${p.accent}"/>
    <ellipse cx="1300" cy="232" rx="110" ry="14" fill="${p.glow}" opacity="0.9"/>
    <rect x="0" y="690" width="1920" height="390" fill="url(#floor)"/>
    <path d="M0 760 L1920 760" stroke="#000" stroke-opacity="0.25" stroke-width="6"/>
    <rect x="-20" y="610" width="1960" height="90" rx="18" fill="#6b3f22"/>
    <rect x="-20" y="600" width="1960" height="26" rx="10" fill="#8a5530"/>
    <g opacity="0.55">${[260, 560, 860].map((x) => `<ellipse cx="${x}" cy="604" rx="110" ry="20" fill="#f3e6cf"/>`).join('')}</g>
    ${[225, 262, 300, 525, 560, 600, 830, 865].map((x, i) => `<circle cx="${x}" cy="${578 - (i % 3) * 22}" r="26" fill="${p.primary}" stroke="#c46f0a" stroke-width="4"/>`).join('')}
    ${dots(40, 3, [200, 540, 920, 600], [1.5, 3], '#fff2c4', [0.5, 0.9])}`;
  return {
    backdrop: svgUrl(body, defs),
    sprites: [
      { key: 'bear-sleep', x: 1560, y: 830, w: 640, depth: 'front' },
      { key: 'ladoo', x: 1210, y: 700, w: 104, rot: 12, depth: 'front', float: true },
      { key: 'grandma-guard', x: 1070, y: 520, w: 150, depth: 'back' },
    ],
  };
}

function lavaPenguins(p: Pal): KeyArt {
  const defs = `
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a1230"/><stop offset="0.6" stop-color="${p.bg}"/><stop offset="1" stop-color="#3a1420"/></linearGradient>
    <radialGradient id="erupt" cx="0.72" cy="0.32" r="0.5"><stop offset="0" stop-color="${p.glow}" stop-opacity="0.85"/><stop offset="0.35" stop-color="${p.accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${p.accent}" stop-opacity="0"/></radialGradient>
    <linearGradient id="lava" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.glow}"/><stop offset="0.35" stop-color="${p.accent}"/><stop offset="1" stop-color="#7a1406"/></linearGradient>
    <linearGradient id="ice" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${p.primary}"/></linearGradient>`;
  const floe = (x: number, y: number, w: number) =>
    `<path d="M${x - w / 2} ${y} l${w * 0.12} -${w * 0.12} h${w * 0.74} l${w * 0.14} ${w * 0.12} l-${w * 0.1} ${w * 0.1} h-${w * 0.8} Z" fill="url(#ice)"/>` +
    `<path d="M${x - w / 2} ${y} l${w * 0.1} ${w * 0.1} h${w * 0.8} l${w * 0.1} -${w * 0.1}" fill="none" stroke="#0a1230" stroke-opacity="0.35" stroke-width="6"/>`;
  const body = `
    <rect width="1920" height="1080" fill="url(#sky)"/>
    ${dots(70, 11, [0, 0, 1920, 520], [1, 3], '#ffffff', [0.25, 0.8])}
    <rect width="1920" height="1080" fill="url(#erupt)"/>
    <path d="M980 720 L1300 330 L1360 345 L1420 320 L1760 720 Z" fill="#160a1e"/>
    <path d="M1300 330 L1360 345 L1420 320 L1405 380 L1360 360 L1318 385 Z" fill="${p.accent}"/>
    <path d="M1340 360 Q1300 470 1250 560 M1385 365 Q1430 480 1460 600" stroke="${p.glow}" stroke-width="10" fill="none" opacity="0.8"/>
    <path d="M-50 800 L380 560 L760 800 Z" fill="#120a24"/><rect x="0" y="700" width="1920" height="100" fill="#120a24"/>
    <rect x="0" y="780" width="1920" height="300" fill="url(#lava)"/>
    <path d="M0 790 Q160 760 320 790 T640 790 T960 790 T1280 790 T1600 790 T1920 790 V820 H0 Z" fill="${p.glow}" opacity="0.5"/>
    <path d="M100 860 q90 -30 180 0 M520 960 q70 -25 140 0 M1100 900 q110 -30 220 0 M1580 1000 q80 -24 160 0" stroke="#ffe08a" stroke-width="8" fill="none" opacity="0.7" stroke-linecap="round"/>
    ${dots(60, 5, [0, 300, 1920, 1000], [2, 6], p.glow, [0.3, 0.9])}
    ${floe(1180, 830, 380)}${floe(1640, 900, 300)}${floe(760, 960, 240)}`;
  return {
    backdrop: svgUrl(body, defs),
    sprites: [
      { key: 'avatar-penguin', x: 1500, y: 800, w: 230, depth: 'front' },
      { key: 'avatar-penguin', x: 1770, y: 860, w: 170, rot: 8, depth: 'front' },
      { key: 'golden-fish', x: 1240, y: 680, w: 140, rot: -25, depth: 'front', float: true },
      { key: 'fireball', x: 1080, y: 420, w: 110, rot: 20, depth: 'back', float: true },
    ],
  };
}

function bearTug(p: Pal): KeyArt {
  const defs = `
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d0d24"/><stop offset="1" stop-color="${p.bg}"/></linearGradient>
    <radialGradient id="moon" cx="0.78" cy="0.2" r="0.35"><stop offset="0" stop-color="${p.primary}" stop-opacity="0.55"/><stop offset="1" stop-color="${p.primary}" stop-opacity="0"/></radialGradient>
    <linearGradient id="snow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f1ff"/><stop offset="1" stop-color="#9aa0d0"/></linearGradient>`;
  const tree = (x: number, y: number, s: number) =>
    `<path d="M${x} ${y - 160 * s} L${x + 70 * s} ${y} H${x - 70 * s} Z" fill="#11112b"/><path d="M${x} ${y - 230 * s} L${x + 55 * s} ${y - 90 * s} H${x - 55 * s} Z" fill="#14143a"/>`;
  const body = `
    <rect width="1920" height="1080" fill="url(#sky)"/>
    ${dots(90, 17, [0, 0, 1920, 600], [1, 3], '#ffffff', [0.3, 1])}
    <rect width="1920" height="1080" fill="url(#moon)"/>
    <circle cx="1500" cy="210" r="90" fill="#fff4d0"/>
    ${tree(1000, 640, 1.2)}${tree(1120, 660, 0.9)}${tree(1820, 650, 1.3)}${tree(1700, 680, 0.8)}${tree(120, 640, 1)}
    <path d="M0 700 Q480 600 960 690 T1920 660 V1080 H0 Z" fill="url(#snow)"/>
    <path d="M0 820 Q520 760 1000 830 T1920 800 V1080 H0 Z" fill="#c9ccef"/>
    <path d="M700 760 Q1250 720 1920 770" stroke="#8a5a2b" stroke-width="30" fill="none" stroke-linecap="round"/>
    <path d="M700 760 Q1250 720 1920 770" stroke="#c48a4a" stroke-width="30" fill="none" stroke-dasharray="26 22" stroke-linecap="round"/>
    <rect x="1240" y="700" width="16" height="110" fill="${p.accent}"/>
    ${dots(50, 23, [0, 650, 1920, 1080], [2, 5], '#ffffff', [0.4, 0.9])}`;
  return {
    backdrop: svgUrl(body, defs),
    sprites: [
      { key: 'bear-awake', x: 1580, y: 800, w: 400, depth: 'front' },
      { key: 'banner-red', x: 1080, y: 640, w: 140, rot: -6, depth: 'back' },
      { key: 'banner-blue', x: 1840, y: 700, w: 130, rot: 6, depth: 'back' },
    ],
  };
}

/** Any other (forged) game: an abstract palette scene. */
/** A neon line drawn twice: a wide faint stroke for the glow, a thin bright one on top (no SVG filters). */
const glowPath = (d: string, c: string, w = 6) =>
  `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w * 5}" stroke-opacity="0.12" stroke-linejoin="round" stroke-linecap="round"/>` +
  `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w * 2.2}" stroke-opacity="0.28" stroke-linejoin="round" stroke-linecap="round"/>` +
  `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;

const circ = (cx: number, cy: number, r: number) => `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 ${-r * 2} 0`;
const hex = (cx: number, cy: number, r: number) =>
  `M${Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 6 + (i * Math.PI) / 3; return `${(cx + r * Math.cos(a)).toFixed(0)} ${(cy + r * Math.sin(a)).toFixed(0)}`; }).join(' L')} Z`;

type Motif = 'ring' | 'core' | 'bomb' | 'paint' | 'gates' | 'prism';
const MOTIF: Record<string, Motif> = {
  'fallback-ring-out': 'ring', 'fallback-overload': 'bomb', 'fallback-paint-wars': 'paint',
  'fallback-core-rush': 'core', 'fallback-neon-dash': 'gates',
};

function motif(m: Motif, p: Pal): string {
  const [a, b, c] = [p.primary, p.accent, p.glow];
  switch (m) {
    case 'ring':
      return glowPath(circ(1370, 470, 300), a, 8) + glowPath(circ(1370, 470, 190), b, 5) + glowPath('M1250 470 l60 0 M1490 470 l-60 0', c, 6)
        + `<circle cx="1290" cy="420" r="34" fill="${b}"/><circle cx="1460" cy="520" r="34" fill="${a}"/>`;
    case 'core':
      return glowPath(hex(1380, 460, 220), a, 8) + glowPath(hex(1380, 460, 120), b, 6) + `<circle cx="1380" cy="460" r="46" fill="${c}"/>`
        + glowPath('M1060 820 l120 -60 l120 60', a, 5) + glowPath('M1560 820 l120 -60 l120 60', b, 5);
    case 'bomb':
      return glowPath(circ(1360, 500, 210), b, 8) + glowPath('M1500 330 q60 -90 140 -70', c, 7) + glowPath('M1640 240 l30 -30 M1660 270 l40 0 M1640 220 l0 -40', c, 5)
        + glowPath('M1300 500 l60 -90 l20 70 l60 -10 l-70 110 l-10 -60 z', a, 5);
    case 'paint': {
      let cells = '';
      for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) {
        const own = (x * 7 + y * 3) % 5;
        const col = own < 2 ? a : own < 4 ? b : '';
        cells += `<rect x="${1040 + x * 104}" y="${230 + y * 104}" width="94" height="94" rx="6" fill="${col || 'none'}" fill-opacity="${col ? 0.55 : 0}" stroke="${col || a}" stroke-opacity="${col ? 0.9 : 0.3}" stroke-width="3"/>`;
      }
      return cells;
    }
    case 'gates':
      return [0, 1, 2, 3].map((i) => glowPath(`M${1060 + i * 210} 200 L${1060 + i * 210} 760`, i % 2 ? b : a, 5)
        + glowPath(`M${1060 + i * 210} ${300 + i * 90} l210 0`, c, 4)).join('')
        + glowPath('M1000 860 L1820 860', a, 6);
    case 'prism':
    default:
      return glowPath('M1380 200 L1640 680 L1120 680 Z', a, 8) + glowPath('M1380 330 L1540 620 L1220 620 Z', b, 5) + `<circle cx="1380" cy="520" r="30" fill="${c}"/>`;
  }
}

/** Neon key art: navy sky, horizon glow, a perspective grid floor and the game's motif in neon line art. */
function neon(spec: Pick<GameSpec, 'id'>, p: Pal, seed: number): KeyArt {
  const defs = `
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#070a1f"/><stop offset="0.6" stop-color="#0a0e27"/><stop offset="1" stop-color="#120a33"/></linearGradient>
    <radialGradient id="ga" cx="0.72" cy="0.42" r="0.45"><stop offset="0" stop-color="${p.primary}" stop-opacity="0.32"/><stop offset="1" stop-color="${p.primary}" stop-opacity="0"/></radialGradient>
    <radialGradient id="gb" cx="0.95" cy="0.95" r="0.5"><stop offset="0" stop-color="${p.accent}" stop-opacity="0.3"/><stop offset="1" stop-color="${p.accent}" stop-opacity="0"/></radialGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a0e27" stop-opacity="1"/><stop offset="0.5" stop-color="#0a0e27" stop-opacity="0"/></linearGradient>`;
  let grid = '';
  for (let i = -12; i <= 12; i++) grid += `<line x1="${960 + i * 40}" y1="760" x2="${960 + i * 260}" y2="1080" stroke="${p.primary}" stroke-opacity="0.35" stroke-width="2"/>`;
  for (let j = 0; j < 7; j++) { const y = 760 + Math.pow(j / 6, 1.8) * 320; grid += `<line x1="0" y1="${y.toFixed(0)}" x2="1920" y2="${y.toFixed(0)}" stroke="${p.primary}" stroke-opacity="0.3" stroke-width="2"/>`; }
  const m = MOTIF[spec.id] ?? (['ring', 'core', 'prism', 'gates'] as const)[seed % 4]!;
  const body = `<rect width="1920" height="1080" fill="url(#sky)"/><rect width="1920" height="1080" fill="url(#ga)"/><rect width="1920" height="1080" fill="url(#gb)"/>
    ${dots(70, seed, [0, 0, 1920, 700], [1, 3], '#ffffff', [0.15, 0.6])}
    <rect x="0" y="757" width="1920" height="6" fill="${p.accent}" opacity="0.8"/><rect x="0" y="740" width="1920" height="40" fill="${p.accent}" opacity="0.12"/>
    ${grid}<rect x="0" y="760" width="1920" height="320" fill="url(#fade)"/>
    ${motif(m, p)}`;
  return { backdrop: svgUrl(body, defs), sprites: [] };
}

const BY_ID: Record<string, (p: Pal) => KeyArt> = {
  'fallback-ladoo-heist': ladooHeist,
  'fallback-lava-penguins': lavaPenguins,
  'fallback-bear-tug': bearTug,
};

const cache = new Map<string, KeyArt>();

/** Key art for a game: the fallback scenes by id (or arena), else an abstract palette scene. */
export function keyArtFor(given: Pick<GameSpec, 'id' | 'theme' | 'arena'> & { origin?: GameSpec['origin'] }, generated?: string): KeyArt {
  // generated key art (forge.art 'keyArt') wins; CSS-safe because it passed ArtUrlSchema
  if (generated) return { backdrop: generated, sprites: [] };
  // tweaks and remixes look like the game they came from
  const spec = { ...given, id: rootId(given) };
  // built-in games: the still baked from the real game view
  const still = gameStill(spec.id);
  if (still) return { backdrop: still, sprites: [] };
  const k = `${spec.id}|${JSON.stringify(spec.theme.palette)}`;
  let art = cache.get(k);
  if (!art) {
    const make = BY_ID[spec.id];
    let seed = 0;
    for (const ch of spec.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    art = make ? make(spec.theme.palette) : neon(spec, spec.theme.palette, seed);
    cache.set(k, art);
  }
  return art;
}
