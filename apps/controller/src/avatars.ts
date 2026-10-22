// The 12 premade characters, shared with the TV renderer.
const files = import.meta.glob('../../../packages/render/assets/default/avatar-*.png', {
  eager: true, query: '?url', import: 'default',
}) as Record<string, string>;

export const AVATARS: { key: string; url: string }[] = Object.entries(files)
  .map(([path, url]) => ({ key: /avatar-([a-z]+)\.png$/.exec(path)![1]!, url }))
  .sort((a, b) => a.key.localeCompare(b.key));

export const avatarUrl = (key?: string) => AVATARS.find((a) => a.key === key)?.url;
