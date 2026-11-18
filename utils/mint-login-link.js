// Prints a dashboard sign-in link for the locally seeded owner, without mail.
// Local Wrangler data only; there is intentionally no remote mode. The Worker
// stores a SHA-256 of the token, exactly as src/worker/auth/tokens.ts makes it.
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSeed, wranglerLocal } from './local-tools.js'

try {
  const seed = await readSeed()
  const token = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  const email = seed.email.replaceAll("'", "''")
  const directory = await mkdtemp(join(tmpdir(), 'bugzap-login-'))
  try {
    const file = join(directory, 'login.sql')
    await writeFile(
      file,
      `INSERT INTO login_tokens (token_hash, user_id, expires_at)
  SELECT '${hash}', id, unixepoch() + 900 FROM users WHERE email = '${email}';\n`,
      { mode: 0o600, flag: 'wx' },
    )
    wranglerLocal(['d1', 'execute', 'bugzap', '--local', '--file', file])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  const port = process.env.npm_package_config_port ?? '2833'
  console.log(`\nSign in as ${seed.email} (works once, for 15 minutes):`)
  console.log(`http://localhost:${port}/login/confirm?token=${token}`)
  console.log('If the page says the link expired, run npm run setup:local and try again.')
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Run npm run setup:local first.' : error.message)
  process.exitCode = 1
}
