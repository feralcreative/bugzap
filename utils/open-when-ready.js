// Opens the demo host page in a browser once `npm start` is serving.
//
// This lives outside the Worker on purpose. `wrangler dev` reloads on every save,
// so an opener inside it would spawn a new tab each time. It runs once per
// `npm start`, alongside the Worker, and exits as soon as the Worker answers.
//
// Set OPEN_BROWSER=0 to skip.

import { spawn } from 'node:child_process'

const PORT = process.env.npm_package_config_port ?? '2833'
const DEMO_PORT = process.env.npm_package_config_demoPort ?? '2834'
const URL = `http://localhost:${DEMO_PORT}/`
const TIMEOUT_MS = 30000
const POLL_MS = 250

if (process.env.OPEN_BROWSER === '0') process.exit(0)

const opener =
  process.platform === 'darwin'
    ? ['open', [URL]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', URL]]
      : ['xdg-open', [URL]]

// Any HTTP response means the Worker is up.
async function isUp() {
  try {
    await fetch(`http://localhost:${PORT}/healthz`, {
      signal: AbortSignal.timeout(POLL_MS * 2),
    })
    return true
  } catch {
    return false
  }
}

const deadline = Date.now() + TIMEOUT_MS
while (Date.now() < deadline) {
  if (await isUp()) {
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref()
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, POLL_MS))
}

console.warn(`[open] Worker did not answer within ${TIMEOUT_MS / 1000}s; open ${URL} yourself.`)
