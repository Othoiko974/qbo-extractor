import { defineConfig } from 'vite';

// Native modules must be externalized — Vite/Rollup can't bundle .node files.
// Forge's AutoUnpackNativesPlugin handles the asar unpack at package time.
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        /^node:/,
        'electron',
        'better-sqlite3',
        // xlsx uses dynamic `require('fs')` which Vite's bundler turns into
        // undefined. Keep it as an external runtime require.
        'xlsx',
      ],
    },
  },
});
