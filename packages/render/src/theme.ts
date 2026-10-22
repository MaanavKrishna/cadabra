import type { Theme } from '@cadabra/spec';

export type Palette = Theme['palette'];

/** Fonts are bundled by the TV app (Task 20); these stacks fall back to sans-serif. */
export const UI_FONT = 'Figtree, "Helvetica Neue", Arial, sans-serif';
export const DISPLAY_FONT = '"Bricolage Grotesque", Figtree, "Helvetica Neue", Arial, sans-serif';

/** CSS custom properties for re-tinting the DOM UI with a game's palette. */
export function themeVars(theme: Theme): Record<string, string> {
  const p = theme.palette;
  return { '--c-bg': p.bg, '--c-primary': p.primary, '--c-accent': p.accent, '--c-glow': p.glow, '--c-text': p.text };
}

/** '#rrggbb' (or '#rgb') -> 0xrrggbb; unparsable input -> white. */
export function hexToNum(hex: string): number {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isFinite(n) ? n : 0xffffff;
}

export function numToHex(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Linear mix of two 0xrrggbb colours, t in [0, 1]. */
export function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const ch = (s: number) => {
    const x = (a >> s) & 255, y = (b >> s) & 255;
    return Math.round(x + (y - x) * k) << s;
  };
  return ch(16) | ch(8) | ch(0);
}

export function lighten(c: number, t: number): number {
  return mix(c, 0xffffff, t);
}

export function darken(c: number, t: number): number {
  return mix(c, 0x000000, t);
}

/** Distinct, saturated player colours; the first two follow the palette. */
const PLAYER_HUES = [0x4cc9f0, 0xf72585, 0x80ed99, 0xffd166, 0xb388ff, 0xff8c42, 0x2ec4b6, 0xff5d8f];

export function playerColor(index: number, palette?: Palette): number {
  if (palette && index === 0) return hexToNum(palette.primary);
  if (palette && index === 1) return hexToNum(palette.accent);
  return PLAYER_HUES[index % PLAYER_HUES.length]!;
}

export const TEAM_COLORS: [number, number] = [0xff4d5e, 0x3d8bff];
