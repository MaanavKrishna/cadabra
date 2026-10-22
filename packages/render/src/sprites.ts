import type { Palette } from './theme';

/**
 * Engine sprite key -> default art name (file stem in assets/default). Generic engine keys
 * first, then common words a generated spec may use as sprite keys. Any key that is itself
 * a pack file stem (e.g. 'fireball') also resolves directly.
 */
export const DEFAULT_SPRITES: Record<string, string> = {
  item: 'coin',
  hazard: 'fireball',
  goal: 'goal-basket',
  guard: 'bear-sleep',
  obstacle: 'crate',
  'boost-pad': 'boost-pad',
  baton: 'baton',
  rope: 'rope-segment',
  // friendly aliases
  bear: 'bear-sleep',
  dragon: 'dragon-sleep',
  grandma: 'grandma-guard',
  owl: 'owl-watcher',
  robot: 'robot-patrol',
  fish: 'golden-fish',
  rock: 'falling-rock',
  boulder: 'falling-rock',
  ice: 'ice-shard',
  spike: 'spiky-ball',
  gift: 'gift-box',
  chest: 'treasure-chest',
  treasure: 'treasure-chest',
  basket: 'goal-basket',
  flag: 'finish-flag',
  finish: 'finish-flag',
  checkpoint: 'checkpoint-ring',
  ring: 'checkpoint-ring',
  box: 'crate',
};

/** Guard art by guard kind, used when the sprite key is the generic 'guard'. */
const GUARD_BY_KIND: Record<string, string> = { sleeper: 'bear-sleep', patrol: 'robot-patrol', watcher: 'owl-watcher' };

/** Fallback avatar pack, in bot-personality order (bot:<k> wears AVATAR_ART[k]). */
export const AVATAR_ART: readonly string[] = [
  'avatar-penguin', 'avatar-cat', 'avatar-robot', 'avatar-astronaut', 'avatar-dragon', 'avatar-fox',
  'avatar-panda', 'avatar-bunny', 'avatar-monkey', 'avatar-chef', 'avatar-ninja', 'avatar-unicorn',
];

export type ShapeKind = 'blob' | 'orb' | 'spiky' | 'ring' | 'block' | 'guard' | 'pad' | 'gem';

export type SpriteSource =
  | { type: 'url'; url: string; /** texture cache key */ key: string }
  | { type: 'shape'; shape: ShapeKind; color: string; accent: string };

export interface ResolveOpts {
  /** Per-game generated art (sprite key -> url); wins over the default pack. */
  art: Record<string, string>;
  /** Default pack present at runtime (file stem -> url). Missing files are simply absent. */
  defaults: Record<string, string>;
  palette: Palette;
  /** Entity kind; picks the fallback shape. */
  kind?: string;
  /** 'awake' for guards that are awake. */
  variant?: 'awake';
  guardKind?: string;
  /** Player.avatar for `avatar:<id>` keys (url, pack name or `bot:<k>`). */
  avatar?: string;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function isUrl(s: string): boolean {
  return /^(https?:|data:|blob:|\.{0,2}\/)/.test(s) || /\.(png|webp|jpe?g|gif|svg)(\?.*)?$/i.test(s);
}

/**
 * Default avatar art name for a player without generated art: bots keep their personality's
 * face (`bot:<k>`), an explicit pack name is honoured, everyone else gets a stable hash of
 * the player id over the avatar files actually present. undefined if the pack has none.
 */
export function avatarArtFor(p: { id: string; avatar?: string }, defaults: Record<string, string>): string | undefined {
  const present = AVATAR_ART.filter((a) => defaults[a] !== undefined);
  if (present.length === 0) return undefined;
  const av = p.avatar ?? '';
  const bot = /^bot:(\d+)$/.exec(av);
  if (bot) {
    const want = AVATAR_ART[Number(bot[1]) % AVATAR_ART.length]!;
    if (defaults[want]) return want;
  }
  const named = av.startsWith('avatar-') ? av : `avatar-${av}`;
  if (av && defaults[named]) return named;
  return present[fnv1a(p.id) % present.length];
}

const SHAPE_BY_KIND: Record<string, ShapeKind> = {
  player: 'blob', runner: 'blob', item: 'orb', hazard: 'spiky', goal: 'ring', guard: 'guard', obstacle: 'block',
  'boost-pad': 'pad', baton: 'block', 'safe-zone': 'ring',
};

/** Procedural stand-in for an entity kind, in palette colours. */
export function fallbackShape(kind: string | undefined, p: Palette): SpriteSource & { type: 'shape' } {
  const shape = SHAPE_BY_KIND[kind ?? ''] ?? 'gem';
  const color =
    shape === 'spiky' ? p.accent
      : shape === 'orb' ? p.glow
        : shape === 'guard' ? p.accent
          : shape === 'block' ? p.glow
            : p.primary;
  return { type: 'shape', shape, color, accent: shape === 'spiky' ? p.glow : p.accent };
}

/**
 * Where a sprite key's picture comes from: theme art -> default pack -> procedural shape in
 * palette colours. Never throws; anything unknown becomes a shape.
 */
export function resolveSprite(key: string, o: ResolveOpts): SpriteSource {
  const { art, defaults } = o;
  const url = (u: string | undefined, k: string): SpriteSource | undefined => (u ? { type: 'url', url: u, key: k } : undefined);

  if (o.variant === 'awake') {
    const v = url(art[`${key}:awake`], `art:${key}:awake|${art[`${key}:awake`]}`) ?? url(art[`${key}-awake`], `art:${key}-awake|${art[`${key}-awake`]}`);
    if (v) return v;
  }
  // generated art wins even for the awake state (the view tints it), keeping one look
  const a = url(art[key], `art:${key}|${art[key]}`);
  if (a) return a;

  if (key.startsWith('avatar:')) {
    if (o.avatar && isUrl(o.avatar)) return { type: 'url', url: o.avatar, key: `avatar-url:${o.avatar}` };
    const name = avatarArtFor({ id: key.slice(7), avatar: o.avatar ?? '' }, defaults);
    return (name && url(defaults[name], name)) || fallbackShape('player', o.palette);
  }

  let name = (key === 'guard' && o.guardKind ? GUARD_BY_KIND[o.guardKind] : undefined) ?? DEFAULT_SPRITES[key] ?? key;
  if (o.variant === 'awake' && name.endsWith('-sleep')) {
    const awake = name.replace(/-sleep$/, '-awake');
    if (defaults[awake]) name = awake;
  }
  return url(defaults[name], name) ?? fallbackShape(o.kind, o.palette);
}
