// Serves demo/ as a stand-in host site on its own port, so the widget runs on a
// different origin from the Worker and CORS and the origin allowlist are exercised
// for real. {{BUGZAP_ORIGIN}} in any .html file is replaced with the Worker's origin.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSeed, SEED_FILE, toolbox } from './local-tools.js'

const PORT = Number(process.env.npm_package_config_demoPort ?? 2834)
const WORKER = `http://localhost:${process.env.npm_package_config_port ?? 2833}`
const ROOT = join(import.meta.dirname, '..', 'demo')
const core = await toolbox()
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

createServer(async (req, res) => {
  if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`].includes(req.headers.host))
    return void res.writeHead(403).end('Use the local demo origin.')
  let path
  try {
    path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname))
  } catch {
    return void res.writeHead(400).end('Invalid URL.')
  }
  const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path)
  if (!file.startsWith(ROOT + sep)) return void res.writeHead(403).end()
  try {
    let body = await readFile(file)
    if (extname(file) === '.html') {
      let html = body.toString().replaceAll('{{BUGZAP_ORIGIN}}', WORKER)
      if (html.includes('{{BUGZAP_CONFIG}}')) {
        const seed = await readSeed()
        const now = Math.floor(Date.now() / 1000)
        const identity = await core.signIdentity(
          { sub: 'demo-reviewer', name: 'Demo reviewer', iat: now, exp: now + 3600 },
          seed.secret,
        )
        const config = JSON.stringify({ site: seed.site, identity }).replaceAll('<', '\\u003c')
        html = html.replaceAll('{{BUGZAP_CONFIG}}', config)
      }
      body = Buffer.from(html)
    }
    res
      .writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      .end(body)
  } catch (error) {
    const missingSetup = error.code === 'ENOENT' && error.path === fileURLToPath(SEED_FILE)
    res
      .writeHead(missingSetup ? 503 : 404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      .end(missingSetup ? 'Run npm run setup:local, then reload this page.' : 'not found')
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[demo] host site on http://localhost:${PORT}/`))
