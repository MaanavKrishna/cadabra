import { THEME_PALETTES, pickFallback, reskinFallback, type GameSpec, type Pitch, type ThemeLook } from '@cadabra/spec';
import { screenOutput } from './ai/bedrock';
import { lookFor, newSpecId, paletteFits, type LookPitch } from './ai/designer';

const SPRITE_STYLE: Record<ThemeLook, string> = {
  neon: 'glowing neon outline of a',
  toybox: 'glossy plastic toy',
  cosmos: 'glowing space-themed',
  retro: 'chunky 8-bit pixel-art',
};

/** Give a reskinned fallback the pitch's look: sound set, a palette that fits it, sprite prompts in its style. */
function applyLook(spec: GameSpec, look: ThemeLook, palette: Pitch['palette']): void {
  spec.theme.look = look;
  spec.theme.sfxSet = look;
  spec.theme.palette = paletteFits(look, palette.bg) ? { ...palette } : { ...THEME_PALETTES[look] };
  if (look === 'neon') return;
  for (const [k, v] of Object.entries(spec.theme.sprites)) {
    spec.theme.sprites[k] = v.replace(/glowing neon outline of a/g, SPRITE_STYLE[look])
      .replace(/glowing neon/g, SPRITE_STYLE[look]).replace(/, vector arcade style on deep navy/g, '').replace(/, vector arcade style/g, '');
  }
}

const SCREEN_MS = 2000;

/** `p`, or `fallback` if it hasn't settled within `ms`. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((r) => { timer = setTimeout(() => r(fallback), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A guaranteed-playable game for `pitch`: the prebuilt spec with the closest blocks, reskinned with
 * the pitch's title, hook, palette, key art, host lines and (from the ingredients) sprites.
 * The reskinned text is screened (fails closed); if it is blocked or the screen is slow, the base
 * game's own text is kept and only the palette is taken from the pitch.
 */
export async function themedFallback(pitch: Pitch, opts: {
  ingredients?: readonly string[]; familySafe?: boolean; deadline?: number;
  /** Players in the round including bots (2..4, default 4). */
  seats?: number;
} = {}): Promise<GameSpec> {
  const base = pickFallback(pitch.blocksSketch, { seats: opts.seats, hint: `${pitch.title} ${pitch.hook}` });
  const id = newSpecId(pitch.title);
  const themed = reskinFallback(base, pitch, { id, ingredients: opts.ingredients });
  const look = (pitch as LookPitch).look ?? lookFor([...(opts.ingredients ?? []), pitch.title, pitch.hook]);
  applyLook(themed, look, pitch.palette);
  const text = [
    themed.title, themed.hook, themed.host.intro, themed.host.finale, themed.theme.keyArtPrompt,
    ...Object.values(themed.theme.sprites),
  ].join('\n');
  const budget = Math.min(SCREEN_MS, Math.max(300, (opts.deadline ?? Infinity) - Date.now()));
  const ok = await within(
    screenOutput(text, opts.familySafe ?? true).then((v) => v.allowed).catch(() => false), budget, false,
  );
  if (ok) return themed;
  const generic = structuredClone(base) as GameSpec;
  generic.id = id;
  applyLook(generic, look, pitch.palette);
  return generic;
}
