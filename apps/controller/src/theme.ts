// Per-game palette: the TV sends themeVars ({'--c-primary': '#ff5500', ...}); we re-tint the UI.
export const THEME_KEYS = ['bg', 'primary', 'accent', 'glow', 'text'] as const;
const SAFE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|oklch\([\d\s.%/]+\))$/i;

export function applyTheme(vars: unknown, root: HTMLElement = document.documentElement) {
  if (!vars || typeof vars !== 'object') return;
  for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
    const key = k.startsWith('--') ? k : `--c-${k}`;
    if (!THEME_KEYS.some((t) => key === `--c-${t}`)) continue;
    if (typeof v !== 'string' || !SAFE.test(v.trim())) continue;
    root.style.setProperty(key, v.trim());
  }
  const bg = root.style.getPropertyValue('--c-bg');
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}
