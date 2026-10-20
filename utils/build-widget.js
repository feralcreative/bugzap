// Bundles src/widget into dist/assets/v1/bugzap.js, which wrangler serves as a static asset,
// plus the lazily loaded screenshot chunk at a content-hashed path the embed has baked in.
// Runs as wrangler's build.command, so `wrangler dev` rebuilds it on every save under src/widget.

import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

const OUT = 'dist/assets/v1'
const common = {
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
}

const started = Date.now()
const chunk = await build({ ...common, entryPoints: ['src/widget/capture/index.ts'], write: false })
const chunkCode = chunk.outputFiles[0].contents
const chunkName = `capture-${createHash('sha256').update(chunkCode).digest('hex').slice(0, 12)}.js`
await mkdir(OUT, { recursive: true })
for (const name of await readdir(OUT))
  if (/^capture-[0-9a-f]+\.js$/.test(name) && name !== chunkName) await rm(`${OUT}/${name}`)
await writeFile(`${OUT}/${chunkName}`, chunkCode)
const result = await build({
  ...common,
  entryPoints: ['src/widget/index.ts'],
  outfile: `${OUT}/bugzap.js`,
  define: { __BUGZAP_CAPTURE__: JSON.stringify(`/v1/${chunkName}`) },
  metafile: true,
})
await writeFile(
  'dist/assets/_headers',
  `/v1/bugzap.js
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
  Cache-Control: public, max-age=300
/v1/capture-*
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
  Cache-Control: public, max-age=31536000, immutable
`,
)
const size = gzipSync(await readFile('dist/assets/v1/bugzap.js')).length
if (size >= 15 * 1024) throw new Error(`Widget exceeds the 15 KiB gzip budget (${size} bytes).`)
console.log(`[build-widget] ${Object.keys(result.metafile.inputs).length} modules, ${size} bytes gzipped`)
const chunkSize = gzipSync(chunkCode).length
console.log(`[build-widget] ${OUT}/${chunkName}, ${chunkSize} bytes gzipped, loaded on first capture`)
console.log(`[build-widget] ${OUT}/bugzap.js in ${Date.now() - started}ms`)
