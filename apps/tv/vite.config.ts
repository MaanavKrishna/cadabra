import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * `VITE_ENTRY=bench vite build` makes dist/index.html the device benchmark (bench.html), so the
 * installed Android app (which always loads assets/www/index.html) runs it. Without the flag the
 * default entry (the spike page) is untouched.
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
  build: { target: 'es2020', outDir: 'dist' },
});
