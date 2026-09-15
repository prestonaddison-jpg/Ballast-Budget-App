import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Build output goes to dist/client, which wrangler.jsonc serves via the
 * `assets` binding. The Worker owns /api/*; everything else is these files.
 */
export default defineConfig({
  root: here,
  publicDir: resolve(here, 'public'),

  define: {
    // Cache-busts the service worker's shell cache on every build.
    __BALLAST_SW_VERSION__: JSON.stringify(process.env.BALLAST_VERSION ?? `${Date.now()}`),
  },

  build: {
    outDir: resolve(here, '../dist/client'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        // The service worker must land at a STABLE, ROOT path: its default
        // scope is the directory it is served from, so a hashed name under
        // /assets/ could only ever control /assets/.
        sw: resolve(here, 'src/sw.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },

  server: {
    port: 5173,
    proxy: {
      // In `vite dev`, forward API calls to `wrangler dev` so the cookie stays
      // same-origin from the browser's point of view.
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
});
