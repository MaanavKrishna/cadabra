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

/**
 * Player colours in join order (neon arcade, task N1): cyan, magenta, lime, amber, then extras.
 * The same everywhere (field, HUD chips, lobby) whatever the game's palette.
 */
export const PLAYER_HUES: readonly number[] = [0x00e5ff, 0xff2bd6, 0xb6ff3b, 0xffb020, 0x8c7bff, 0xff7a3d, 0x3dffb0, 0xff5d8f];

export function playerColor(index: number, _palette?: Palette): number {
  return PLAYER_HUES[((index % PLAYER_HUES.length) + PLAYER_HUES.length) % PLAYER_HUES.length]!;
}

/** Team 0 cyan, team 1 magenta. */
export const TEAM_COLORS: [number, number] = [0x00e5ff, 0xff2bd6];
