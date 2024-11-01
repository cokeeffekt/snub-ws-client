import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import { minify } from 'terser';
import { readFileSync } from 'fs';

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
      inlineWorkerAsBlob(),
    ],
  }
];


function inlineWorkerAsBlob() {
  return {
    name: 'inline-worker-as-blob',
    async transform(code, id) {
      // Only process worker files (e.g., with .worker.js extension)
      if (id.endsWith('worker.js')) {
        // Read the worker code
        const workerCode = readFileSync(id, 'utf8');

        // Minify the worker code
        const minified = await minify(workerCode);

        // Generate Blob URL code with minified content
        const blobUrlCode = `
          const blob = new Blob([${JSON.stringify(minified.code)}], { type: 'application/javascript' });
          export default URL.createObjectURL(blob);
        `;
        
        return { code: blobUrlCode, map: null };
      }
      return null;
    }
  };
}