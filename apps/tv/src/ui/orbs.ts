// Premium procedural avatars: a glossy gradient orb with a simple white geometric glyph. Drawn as
// a tiny SVG data URL once per key (cached). Same keys and look on the phone (apps/controller/src/orbs.ts
// is a copy: neither app may import the other). Keys are [a-z]{1,20} so they pass the avatar schema.
export const ORB_KEYS = [
  'bolt', 'star', 'diamond', 'wave', 'hex', 'ring', 'triangle', 'cross', 'moon', 'spark', 'leaf', 'crown',
] as const;
export type OrbKey = (typeof ORB_KEYS)[number];

/** One hue per glyph, tuned to sit next to the neon game palette. */
const HUE: Record<OrbKey, [string, string]> = {
  bolt: ['#6fe3ff', '#0a6fb8'], star: ['#ffd36e', '#c46a00'], diamond: ['#9ef0ff', '#2a7fd6'], wave: ['#7cf2c8', '#0f8a6a'],
  hex: ['#c4a2ff', '#5b2fc9'], ring: ['#ff9fd8', '#c0267f'], triangle: ['#ffb08a', '#d2451f'], cross: ['#ff8fa0', '#b8203d'],
  moon: ['#b9c6ff', '#3446b8'], spark: ['#f6ff8a', '#7fa30a'], leaf: ['#a6f78a', '#2f8f2a'], crown: ['#ffe39a', '#b88300'],
};

const GLYPH: Record<OrbKey, string> = {
  bolt: '<path d="M54 18 30 54h16l-6 28 26-38H50z" fill="#fff"/>',
  star: '<path d="M50 20l8.8 18 19.8 2.9-14.3 14 3.4 19.7L50 65.3 32.3 74.6l3.4-19.7-14.3-14 19.8-2.9z" fill="#fff"/>',
  diamond: '<path d="M50 20 74 50 50 80 26 50z" fill="#fff"/><path d="M50 20 62 50 50 80" fill="rgba(0,0,0,.12)"/>',
  wave: '<path d="M22 44q7-10 14 0t14 0 14 0 14 0M22 60q7-10 14 0t14 0 14 0 14 0" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/>',
  hex: '<path d="M50 22l24 14v28L50 78 26 64V36z" fill="none" stroke="#fff" stroke-width="8" stroke-linejoin="round"/>',
  ring: '<circle cx="50" cy="50" r="20" fill="none" stroke="#fff" stroke-width="9"/>',
  triangle: '<path d="M50 24 76 72H24z" fill="#fff" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>',
  cross: '<path d="M50 26v48M26 50h48" stroke="#fff" stroke-width="12" stroke-linecap="round"/>',
  moon: '<path d="M60 24a28 28 0 1 0 16 46A24 24 0 0 1 60 24z" fill="#fff"/>',
  spark: '<path d="M50 20q4 26 30 30-26 4-30 30-4-26-30-30 26-4 30-30z" fill="#fff"/>',
  leaf: '<path d="M28 72C28 40 48 26 74 26c0 30-16 46-46 46z" fill="#fff"/><path d="M30 70 60 40" stroke="rgba(0,0,0,.18)" stroke-width="4" stroke-linecap="round"/>',
  crown: '<path d="M24 66 28 34l14 14 8-20 8 20 14-14 4 32z" fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>',
};

const cache = new Map<string, string>();

export const isOrbKey = (k: unknown): k is OrbKey => typeof k === 'string' && (ORB_KEYS as readonly string[]).includes(k);

/** FNV-1a: a stable orb for an unknown key or id (old animal keys, bots). */
export function orbFor(seed: string): OrbKey {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  return ORB_KEYS[h % ORB_KEYS.length]!;
}

/** The orb's image as a data URL (about 1 KB of SVG). */
export function orbUrl(key: OrbKey): string {
  let url = cache.get(key);
  if (url) return url;
  const [light, dark] = HUE[key];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>`
    + `<radialGradient id="g" cx="34%" cy="28%" r="80%"><stop offset="0" stop-color="${light}"/><stop offset=".62" stop-color="${dark}"/><stop offset="1" stop-color="#0b0d16"/></radialGradient>`
    + `<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    + `</defs><circle cx="50" cy="50" r="50" fill="url(#g)"/>`
    + `<ellipse cx="44" cy="24" rx="28" ry="14" fill="url(#s)"/>`
    + `<g opacity=".95">${GLYPH[key]}</g></svg>`;
  url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  cache.set(key, url);
  return url;
}
