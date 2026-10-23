import { isSelfieAvatar } from '@cadabra/spec';
import { ORB_KEYS, isOrbKey, orbFor, orbUrl } from './orbs';

// The 12 premade avatars: glossy glyph orbs, the same keys and look as on the TV.
export const AVATARS: { key: string; url: string }[] = ORB_KEYS.map((key) => ({ key, url: orbUrl(key) }));

/** A premade key (older animal keys map to an orb), or an on-phone toon selfie which is its own image url. */
export function avatarUrl(key?: string): string | undefined {
  const k: string = key ?? '';
  if (!key) return undefined;
  if (isSelfieAvatar(key)) return key as string;
  if (k.startsWith('selfie:')) return undefined; // someone else's selfie: the TV never sends it
  return orbUrl(isOrbKey(k) ? k : orbFor(k));
}
