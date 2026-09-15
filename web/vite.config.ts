import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Placeholder the service worker is compiled with, replaced after bundling. */
const SHELL_TOKEN = '__BALLAST_SHELL_PLACEHOLDER__';

/**
 * Injects the built app-shell file list into the service worker.
 *
 * Asset filenames are content-hashed, so they cannot be known when sw.ts is
 * written. This runs in `generateBundle`, once every emitted filename exists,
 * and rewrites the placeholder in the sw chunk with the real list.
 *
 * Excluded deliberately: the service worker itself (it is never served from
 * its own cache) and source maps (large, and useless offline).
 */
function ballastShellManifest(): Plugin {
  return {
    name: 'ballast-shell-manifest',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => name !== 'sw.js' && !name.endsWith('.map'))
        .map((name) => `/${name}`);

      // '/index.html' is listed EXPLICITLY rather than relied on to appear in
      // `bundle`: Vite's own HTML plugin emits it in a later generateBundle
      // hook than this one, so it is simply not present here. It is also
      // cached separately from '/' — Cache Storage matches on URL, so a
      // navigation to the origin root does not hit the '/index.html' key.
      const shell = ['/', '/index.html', '/manifest.webmanifest', ...files];

      const sw = bundle['sw.js'];
      if (!sw || sw.type !== 'chunk') {
        this.warn('sw.js chunk not found — the service worker shell list was not injected');
        return;
      }
      if (!sw.code.includes(SHELL_TOKEN)) {
        this.warn(`service worker did not contain ${SHELL_TOKEN} — shell list not injected`);
        return;
      }
      sw.code = sw.code.replace(JSON.stringify([SHELL_TOKEN]), JSON.stringify([...new Set(shell)]));
    },
  };
}

/**
 * Build output goes to dist/client, which wrangler.jsonc serves via the
 * `assets` binding. The Worker owns /api/*; everything else is these files.
 */
export default defineConfig({
  root: here,
  publicDir: resolve(here, 'public'),

  plugins: [ballastShellManifest()],

  define: {
    // Cache-busts the service worker's shell cache on every build.
    __BALLAST_SW_VERSION__: JSON.stringify(process.env.BALLAST_VERSION ?? `${Date.now()}`),
    // A syntactically valid array standing in for the real shell list, which
    // only exists once filenames are hashed. ballastShellManifest swaps it.
    __BALLAST_SHELL__: JSON.stringify([SHELL_TOKEN]),
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
