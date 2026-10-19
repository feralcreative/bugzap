// Creates only local Wrangler data. There is intentionally no remote mode.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { assertIgnored, localKek, readSeed, SEED_FILE, toolbox, wranglerLocal, writePrivate } from './local-tools.js'

try {
  const { values } = parseArgs({ options: { origin: { type: 'string' } } })
  const core = await toolbox()
  const origin = core.normalizeOrigin(values.origin ?? 'http://localhost:2834')
  if (!origin) throw new Error('Use an HTTPS origin, or HTTP on localhost.')
  const kek = await localKek()
  assertIgnored(SEED_FILE)
  let seed
  try {
    seed = await readSeed()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    seed = {
      accountId: core.generateId(),
      site: core.generatePublicKey(),
      secret: core.generateSecretKey(),
      origin,
      name: 'Local demo',
      email: 'owner@example.invalid',
    }
    await writePrivate(SEED_FILE, JSON.stringify(seed, null, 2) + '\n')
    seed = await readSeed()
  }
  const cipher = await core.encryptSiteSecret(seed.secret, kek, seed.site)
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'"
  // Build the seed in a private temporary file: neither the signing key nor its
  // encrypted envelope appears in shell arguments or Wrangler's query output.
  const sql = `
INSERT INTO accounts (public_id, name) VALUES (${quote(seed.accountId)}, 'Local demo') ON CONFLICT (public_id) DO NOTHING;
INSERT INTO users (email, name) VALUES (${quote(seed.email)}, 'Local owner') ON CONFLICT (email) DO NOTHING;
INSERT OR IGNORE INTO memberships (account_id, user_id)
  SELECT a.id, u.id FROM accounts a, users u WHERE a.public_id = ${quote(seed.accountId)} AND u.email = ${quote(seed.email)};
INSERT INTO sites (account_id, public_key, name, secret_cipher)
  SELECT id, ${quote(seed.site)}, ${quote(seed.name)}, ${quote(cipher)} FROM accounts WHERE public_id = ${quote(seed.accountId)}
  ON CONFLICT (public_key) DO NOTHING;
INSERT OR IGNORE INTO site_origins (account_id, site_id, origin)
  SELECT account_id, id, ${quote(values.origin ? origin : seed.origin)} FROM sites WHERE public_key = ${quote(seed.site)};
`
  const directory = await mkdtemp(join(tmpdir(), 'bugzap-seed-'))
  try {
    const file = join(directory, 'seed.sql')
    await writeFile(file, sql, { mode: 0o600, flag: 'wx' })
    wranglerLocal(['d1', 'migrations', 'apply', 'bugzap', '--local'])
    wranglerLocal(['d1', 'execute', 'bugzap', '--local', '--file', file])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  console.log(`Local site ready: ${seed.site}`)
  console.log(`Allowed origin: ${values.origin ? origin : seed.origin}`)
  console.log('Signing credentials are in .dev.vars.seed.json (private, Git-ignored).')
} catch (error) {
  // Binding errors may contain SQL. Keep secrets out of the terminal on failure.
  console.error(error.code === 'ENOENT' ? 'Local setup could not find a required file.' : error.message)
  process.exitCode = 1
}
