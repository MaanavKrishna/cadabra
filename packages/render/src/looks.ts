/**
 * Render looks (round R2): four procedural art directions sharing one art-key contract.
 * - neon:   glowing outlines on deep navy (task N1).
 * - toybox: glossy vinyl toys on a clean light play mat, soft shadows, no glow.
 * - cosmos: a ringed arena floating in deep space, astronaut orbs with visors.
 * - retro:  low-res pixel art drawn small and scaled up with nearest filtering.
 * A look only changes pictures and sound, never gameplay.
 */
import type { Theme } from '@cadabra/spec';
import type { Palette } from './theme';

export type LookId = 'neon' | 'toybox' | 'cosmos' | 'retro';
export const LOOK_IDS: readonly LookId[] = ['neon', 'toybox', 'cosmos', 'retro'];

/** Semantic colours a look draws with (names kept from the neon set the entity layer grew up on). */
export interface LookColors {
  /** Darkest ink: pupils, outlines, hole insides. */
  bg: number;
  cyan: number;
  magenta: number;
  lime: number;
  amber: number;
  /** Danger: spikes, lasers, barrels, the unstable core. */
  red: number;
  white: number;
}

export interface Look {
  id: LookId;
  c: LookColors;
  /** Player colours in join order (same hue family in every look: blue, pink, green, yellow). */
  players: readonly number[];
  teams: [number, number];
  /** Default palette when a spec ships none for this look. */
  palette: Palette;
  /** Glow sprites, ribbons and afterimages blend additively (dark looks) or normally (light). */
  additive: boolean;
  /** Soft dark contact shadow under bodies and props (light floors). */
  shadows: boolean;
  /** Player light ribbon behind moving bodies. */
  ribbon: boolean;
  /** Pixel art: textures use nearest filtering, rotations snap to 8 steps. */
  pixel: boolean;
  /** Separate eye sprites over the body (retro bakes its eyes into the pixels). */
  eyes: boolean;
  /** Pupil colour (eye sprites). */
  pupil: number;
  /** Floor ring under each player: alpha of the fill / stroke. */
  ring: [number, number];
  /** Music style and sfx set. */
  sound: string;
}

export const LOOKS: Record<LookId, Look> = {
  neon: {
    id: 'neon',
    c: { bg: 0x0a0e27, cyan: 0x00e5ff, magenta: 0xff2bd6, lime: 0xb6ff3b, amber: 0xffb020, red: 0xff3355, white: 0xffffff },
    players: [0x00e5ff, 0xff2bd6, 0xb6ff3b, 0xffb020, 0x8c7bff, 0xff7a3d, 0x3dffb0, 0xff5d8f],
    teams: [0x00e5ff, 0xff2bd6],
    palette: { bg: '#0A0E27', primary: '#00E5FF', accent: '#FF2BD6', glow: '#B6FF3B', text: '#FFFFFF' },
    additive: true, shadows: false, ribbon: true, pixel: false, eyes: true, pupil: 0x0a0e27, ring: [0.1, 0.85], sound: 'neon',
  },
  toybox: {
    id: 'toybox',
    c: { bg: 0x241a3d, cyan: 0x2f8cff, magenta: 0xff4f9a, lime: 0x3fc94a, amber: 0xffb31a, red: 0xff4a3d, white: 0xffffff },
    players: [0x2f8cff, 0xff4f9a, 0x3fc94a, 0xffb31a, 0x8a5cff, 0xff7a2f, 0x1fc7b6, 0xe8457a],
    teams: [0x2f8cff, 0xff4f9a],
    palette: { bg: '#3B7BFF', primary: '#2F8CFF', accent: '#FF4F9A', glow: '#FFB31A', text: '#FFFFFF' },
    additive: false, shadows: true, ribbon: false, pixel: false, eyes: true, pupil: 0x1b1433, ring: [0.16, 0.9], sound: 'toybox',
  },
  cosmos: {
    id: 'cosmos',
    c: { bg: 0x050817, cyan: 0x63e2ff, magenta: 0xc77dff, lime: 0x7dffb6, amber: 0xffc766, red: 0xff5b78, white: 0xffffff },
    players: [0x63e2ff, 0xff7ad9, 0x7dffb6, 0xffc766, 0xa98bff, 0xff9a5c, 0x5cffd8, 0xff6f9a],
    teams: [0x63e2ff, 0xff7ad9],
    palette: { bg: '#050817', primary: '#63E2FF', accent: '#C77DFF', glow: '#FFC766', text: '#F2F4FF' },
    additive: true, shadows: false, ribbon: true, pixel: false, eyes: true, pupil: 0x050817, ring: [0.08, 0.7], sound: 'cosmos',
  },
  retro: {
    id: 'retro',
    // PICO-8-like 16-colour family: each game uses a handful of these
    c: { bg: 0x000000, cyan: 0x29adff, magenta: 0xff77a8, lime: 0x00e436, amber: 0xffec27, red: 0xff004d, white: 0xfff1e8 },
    players: [0x29adff, 0xff77a8, 0x00e436, 0xffec27, 0x83769c, 0xffa300, 0x00b543, 0xff004d],
    teams: [0x29adff, 0xff77a8],
    palette: { bg: '#1D2B53', primary: '#29ADFF', accent: '#FF77A8', glow: '#FFEC27', text: '#FFF1E8' },
    additive: false, shadows: false, ribbon: false, pixel: true, eyes: false, pupil: 0x000000, ring: [0, 0.9], sound: 'retro',
  },
};

const isLook = (v: unknown): v is LookId => typeof v === 'string' && (LOOK_IDS as readonly string[]).includes(v);

/**
 * Which look draws a theme: an explicit look id (`look`, `id`, `style` or a look-named sfxSet),
 * else words in the art style ("plastic toy" -> toybox, "space" -> cosmos, "pixel" -> retro),
 * else neon.
 */
export function lookOf(theme: Theme | undefined): LookId {
  if (!theme) return 'neon';
  const t = theme as unknown as Record<string, unknown>;
  for (const k of ['look', 'id', 'style', 'renderTheme', 'kind']) if (isLook(t[k])) return t[k] as LookId;
  // 'neon' is also the default sfx set, so only the other look ids count here
  if (isLook(theme.sfxSet) && theme.sfxSet !== 'neon') return theme.sfxSet as LookId;
  const s = `${theme.artStyle ?? ''}`.toLowerCase();
  if (/toy|plastic|vinyl|lego|block|candy|jelly/.test(s)) return 'toybox';
  if (/space|cosmo|galax|star|planet|astro|orbit|nebula/.test(s)) return 'cosmos';
  if (/pixel|retro|8-?bit|chiptune|crt|16-?bit/.test(s)) return 'retro';
  return 'neon';
}

/** Music / sfx set for a theme: the look's own sound unless the spec names a non-neon set. */
export function soundOf(theme: Theme | undefined): string {
  const look = lookOf(theme);
  if (look !== 'neon') return LOOKS[look].sound;
  return theme?.sfxSet ?? 'neon';
}
