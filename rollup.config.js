import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import { minify } from 'terser';
import { readFileSync } from 'fs';

// Must match the literal passed to `new URL(...)` in src/index.js — that literal
// is what bundlers statically analyse in order to relocate the worker asset.
const WORKER_FILE_NAME = 'snub-ws-client.worker.js';

export default [
  {
    input: 'src/index.js',
    output: [
      {
        file: 'dist/snub-ws-client.esm.js',
        format: 'esm',           // ES Module
        sourcemap: true,
      },
      {
        file: 'dist/snub-ws-client.cjs.js',
        format: 'cjs',           // CommonJS for Node.js
        exports: 'auto',
        sourcemap: true,
      },
      {
        file: 'dist/snub-ws-client.min.js',
        format: 'iife',          // IIFE for direct browser usage
        name: 'SnubWsClient',       // Global variable name in the browser
        plugins: [terser()],     // Minification for browser build
        sourcemap: true,
      }
    ],
    plugins: [
      resolve(),
      commonjs(),
      workerScript(),
    ],
  }
];

// The worker ships two ways:
//   1. as its own dist file, so the worker constructor gets a stable per-origin
//      URL and tabs actually share one SharedWorker. A blob: URL is unique per
//      document, so with the blob every tab builds its own worker and its own
//      socket — sharing silently does not happen.
//   2. inlined as a source string used to build that blob: URL, kept as a
//      last-resort fallback when no stable URL can be resolved.
function workerScript() {
  let workerSource = null;

  return {
    name: 'snub-worker-script',
    async transform(code, id) {
      // Only process worker files (e.g., with .worker.js extension)
      if (!id.endsWith('worker.js')) return null;

      // Read and minify the worker code
      workerSource = (await minify(readFileSync(id, 'utf8'))).code;

      // Replace the module with a lazy blob-URL factory. Lazy because the blob
      // is now only a fallback — building it eagerly would leak an object URL
      // on every import and call URL.createObjectURL in non-browser contexts.
      return {
        code: `
          const WORKER_SOURCE = ${JSON.stringify(workerSource)};
          let blobUrl = null;
          export function workerBlobUrl() {
            if (!blobUrl) {
              const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
              blobUrl = URL.createObjectURL(blob);
            }
            return blobUrl;
          }
        `,
        map: null,
      };
    },
    generateBundle() {
      // Runs once per output; all three write to dist/, with identical bytes.
      if (!workerSource) return;
      this.emitFile({
        type: 'asset',
        fileName: WORKER_FILE_NAME,
        source: workerSource,
      });
    },
  };
}