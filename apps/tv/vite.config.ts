import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * `VITE_ENTRY=bench vite build` makes dist/index.html the device benchmark (bench.html), so the
 * installed Android app (which always loads assets/www/index.html) runs it. Without the flag the
 * default entry is the real TV app (index.html -> src/main.tsx).
 */
function benchEntry(): Plugin {
  return {
    name: 'cadabra-bench-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (process.env.VITE_ENTRY !== 'bench' || !/(^|[\\/])index\.html$/.test(ctx.filename)) return html;
        return readFileSync(resolve(__dirname, 'bench.html'), 'utf8');
      },
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [benchEntry()],
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  server: { host: true, fs: { allow: ['../..'] } },
  build: {
    target: 'es2020',
    outDir: 'dist',
    // keep the default art pack as files (the WebView caches them; no huge inlined data URLs)
    assetsInlineLimit: 0,
  },
  test: { include: ['test/**/*.test.{ts,tsx}'] },
});
