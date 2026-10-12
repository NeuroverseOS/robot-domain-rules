import { defineConfig } from 'vitest/config';

// The switchboard is served from https://neuroverseos.github.io/robot-domain-rules/
export default defineConfig({
  base: '/robot-domain-rules/',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  server: { fs: { allow: ['..'] } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
