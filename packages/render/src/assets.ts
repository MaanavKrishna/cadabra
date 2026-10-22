/// <reference types="vite/client" />
/**
 * The default art pack (assets/default/*.png), resolved by Vite to relative asset URLs so it
 * works from file-like origins (https://appassets.androidplatform.net/assets/www/). Whatever
 * files are present are picked up; missing ones simply have no entry.
 */
const files = import.meta.glob('../assets/default/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export const DEFAULT_ART_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1).replace(/\.png$/, ''), url]),
);
