// Bundles src/widget into dist/assets/v1/bugzap.js, which wrangler serves as a static asset.
// Runs as wrangler's build.command, so `wrangler dev` rebuilds it on every save under src/widget.

import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

const started = Date.now()
const result = await build({
  entryPoints: ['src/widget/index.ts'],
  outfile: 'dist/assets/v1/bugzap.js',
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
})
await writeFile(
  'dist/assets/_headers',
  `/v1/bugzap.js
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
  Cache-Control: public, max-age=300
`,
)
const size = gzipSync(await readFile('dist/assets/v1/bugzap.js')).length
if (size >= 15 * 1024) throw new Error(`Widget exceeds the 15 KiB gzip budget (${size} bytes).`)
console.log(`[build-widget] ${Object.keys(result.metafile.inputs).length} modules, ${size} bytes gzipped`)
console.log(`[build-widget] dist/assets/v1/bugzap.js in ${Date.now() - started}ms`)
