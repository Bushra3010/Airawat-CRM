'use strict';
// Bundles worker/index.js for Cloudflare Workers into dist/worker.js (wrangler.jsonc uploads it as-is).
// Bundled here rather than by Wrangler: Wrangler applies package "browser" fields, which stubs out
// iconv-lite's stream support that Express's body parser needs.
const path = require('path');
require('esbuild').buildSync({
  entryPoints: [path.join(__dirname, '..', 'worker', 'index.js')],
  outfile: path.join(__dirname, '..', 'dist', 'worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  conditions: ['workerd', 'worker'],
  external: ['cloudflare:*', 'node:*'],
  // pdfkit's Node build reads its font files from disk at runtime; the standalone build embeds them.
  // debug's Node build needs tty, which Workers lacks.
  alias: {
    pdfkit: path.join(__dirname, '..', 'node_modules', 'pdfkit', 'js', 'pdfkit.standalone.js'),
    debug: path.join(__dirname, '..', 'node_modules', 'debug', 'src', 'browser.js'),
  },
  // CommonJS dependencies require() Node builtins; give the ESM bundle a require() that workerd resolves.
  // workerd's createRequire returns module namespaces; CommonJS code expects the default export
  // (e.g. require('stream') must be the Stream class).
  banner: { js: "import { createRequire as __cr } from 'node:module'; const __nodeRequire = __cr('/worker.js'); const require = (m) => { const x = __nodeRequire(m); return x && x.default !== undefined ? x.default : x; }; const __dirname = '/', __filename = '/worker.js';" },
  logLevel: 'warning',
});
console.log('Built dist/worker.js');
