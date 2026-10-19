// Shared by local setup tools. Bundle the real TS modules in memory rather than
// maintaining a second implementation of signing or encryption in JavaScript.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const SEED_FILE = new URL('../.dev.vars.seed.json', import.meta.url)
export const VARS_FILE = new URL('../.dev.vars', import.meta.url)

export async function toolbox() {
  const result = await build({
    stdin: {
      contents: `export * from './src/core/ids'; export * from './src/core/identity';
        export * from './src/core/url'; export * from './src/worker/crypto';`,
      resolveDir: ROOT,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)
}

export function assertIgnored(file) {
  const check = spawnSync('git', ['check-ignore', '--quiet', '--', fileURLToPath(file)], { cwd: ROOT })
  if (check.status !== 0) throw new Error('Local credential files must be ignored by Git before setup can continue.')
}

export async function writePrivate(file, contents) {
  const absolute = file instanceof URL ? fileURLToPath(file) : resolve(file)
  const local = relative(ROOT, absolute)
  if (local !== '..' && !local.startsWith('../') && !isAbsolute(local)) assertIgnored(pathToFileURL(absolute))
  await writeFile(file, contents, { flag: 'wx', mode: 0o600 })
}

export async function readSeed() {
  assertIgnored(SEED_FILE)
  const raw = await readFile(SEED_FILE, 'utf8')
  let seed
  try {
    seed = JSON.parse(raw)
  } catch {
    throw new Error('The local seed file is not valid JSON.')
  }
  const { isPublicId, isPublicKey, isSecretKey, normalizeOrigin } = await toolbox()
  if (
    !seed ||
    typeof seed !== 'object' ||
    Array.isArray(seed) ||
    !isPublicId(seed.accountId) ||
    !isPublicKey(seed.site) ||
    !isSecretKey(seed.secret) ||
    normalizeOrigin(seed.origin) !== seed.origin ||
    typeof seed.email !== 'string' ||
    typeof seed.name !== 'string'
  )
    throw new Error('The local seed file is invalid.')
  await chmod(SEED_FILE, 0o600)
  return seed
}

export async function localKek() {
  assertIgnored(VARS_FILE)
  try {
    const { base64UrlEncode } = await toolbox()
    const key = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
    await writePrivate(VARS_FILE, `# Local development only. Do not commit.\nSITE_KEK=${key}\n`)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const vars = await readFile(VARS_FILE, 'utf8')
  const match = /^SITE_KEK\s*=\s*(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))\s*$/m.exec(vars)
  if (!match) throw new Error('Set SITE_KEK in .dev.vars to a base64url-encoded 32-byte key, then rerun setup.')
  await chmod(VARS_FILE, 0o600)
  return match[1] ?? match[2] ?? match[3]
}

export function wranglerLocal(args) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
  if (result.status !== 0) throw new Error('Local database setup failed.')
}
