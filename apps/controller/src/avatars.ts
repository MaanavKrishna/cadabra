import { isSelfieAvatar } from '@cadabra/spec';

// The 12 premade characters, shared with the TV renderer.
const files = import.meta.glob('../../../packages/render/assets/default/avatar-*.png', {
  eager: true, query: '?url', import: 'default',
}) as Record<string, string>;

export const AVATARS: { key: string; url: string }[] = Object.entries(files)
  .map(([path, url]) => ({ key: /avatar-([a-z]+)\.png$/.exec(path)![1]!, url }))
  .sort((a, b) => a.key.localeCompare(b.key));

/** A premade key, or an on-phone toon selfie (a small data: URL) which is its own image url. */
export const avatarUrl = (key?: string) => (isSelfieAvatar(key) ? key : AVATARS.find((a) => a.key === key)?.url);
