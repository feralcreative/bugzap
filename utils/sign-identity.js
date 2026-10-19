// Host-side helper for the local seeded site. Do not ship this signing key to a
// browser: the future widget receives only the resulting short-lived token.
import { parseArgs } from 'node:util'
import { readSeed, toolbox, writePrivate } from './local-tools.js'

try {
  const { values } = parseArgs({
    options: {
      sub: { type: 'string', default: 'demo-reporter' },
      email: { type: 'string' },
      name: { type: 'string' },
      ttl: { type: 'string', default: '86400' },
      output: { type: 'string' },
    },
  })
  const core = await toolbox()
  const seed = await readSeed()
  const ttl = Number(values.ttl)
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > core.IDENTITY_MAX_LIFETIME_S)
    throw new Error('Token lifetime must be 1–604800 seconds (default: 86400).')
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    sub: values.sub,
    ...(values.email && { email: values.email }),
    ...(values.name && { name: values.name }),
    iat: now,
    exp: now + ttl,
  }
  const token = await core.signIdentity(claims, seed.secret)
  if (!(await core.verifyIdentity(token, [seed.secret], now)).ok)
    throw new Error('Use a subject of 1–128 characters, a valid email, and a name of at most 100 characters.')
  if (values.output) {
    await writePrivate(values.output, token + '\n')
    console.error('Identity token written to the requested file (mode 600).')
  } else {
    process.stdout.write(token + '\n')
  }
} catch (error) {
  console.error(
    error.code === 'ENOENT'
      ? 'Run npm run setup:local first.'
      : error.code === 'EEXIST'
        ? 'The output file already exists; choose a new path.'
        : error.message,
  )
  process.exitCode = 1
}
