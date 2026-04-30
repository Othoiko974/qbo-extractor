import { defineConfig } from 'vite';

// Native modules must be externalized — Vite/Rollup can't bundle .node files.
// Forge's AutoUnpackNativesPlugin handles the asar unpack at package time.
export default defineConfig({
  // Bake QBO OAuth developer credentials into the bundle at build time.
  // CI sets these as GitHub Actions secrets so the source repo stays clean
  // (no creds in git). Local dev builds without them just leave the env
  // lookup undefined — Settings.getQboAppCreds() (keychain) takes over so
  // the developer can paste creds via Settings UI as before.
  define: {
    'process.env.QBO_CLIENT_ID': JSON.stringify(process.env.QBO_CLIENT_ID ?? ''),
    'process.env.QBO_CLIENT_SECRET': JSON.stringify(process.env.QBO_CLIENT_SECRET ?? ''),
  },
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
