import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  resolve: { alias: { react: 'preact/compat', 'react-dom': 'preact/compat' } },
  server: { host: true, fs: { allow: ['../..'] } },
  build: { target: 'es2020', outDir: 'dist', assetsInlineLimit: 0 },
  test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'] },
});
