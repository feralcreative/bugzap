import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { generateId } from '../../src/core/ids'
import { signIdentity } from '../../src/core/identity'
import app from '../../src/worker'
import { generateToken, hashToken } from '../../src/worker/auth/tokens'
import { SESSION_TTL_S } from '../../src/worker/db/auth'

export const BASE = 'http://bugzap.test'
export const OWNER = 'owner@allowed.example' // On the allowlist in vitest.config.ts.
export const now = () => Math.floor(Date.now() / 1000)
export const open = { limit: async () => ({ success: true }) }

export type Options = {
  method?: string
  form?: Record<string, string>
  cookie?: string
  origin?: string | null
  base?: string
  env?: Partial<Env>
}

export function call(path: string, options: Options = {}) {
  const base = options.base ?? BASE
  const headers = new Headers()
  if (options.cookie) headers.set('Cookie', options.cookie)
  const method = options.method ?? (options.form ? 'POST' : 'GET')
  if (method !== 'GET' && options.origin !== null) headers.set('Origin', options.origin ?? base)
  let body: string | undefined
  if (method !== 'GET') {
    headers.set('Content-Type', 'application/x-www-form-urlencoded')
    body = new URLSearchParams(options.form ?? {}).toString()
  }
  return app.fetch(
    new Request(base + path, { method, headers, body, redirect: 'manual' }),
    { ...env, INGEST_BURST: open, ...options.env },
    createExecutionContext(),
  )
}

/** A signed-in owner with their own account, made directly in the database. */
export async function owner(email = `${generateId().toLowerCase()}@team.example`) {
  const accountId = (await env.DB.prepare('INSERT INTO accounts (public_id, name) VALUES (?, ?) RETURNING id')
    .bind(generateId(), 'Test account')
    .first<{ id: number }>())!.id
  const userId = (await env.DB.prepare('INSERT INTO users (email) VALUES (?) RETURNING id')
    .bind(email)
    .first<{ id: number }>())!.id
  await env.DB.prepare('INSERT INTO memberships (account_id, user_id) VALUES (?, ?)').bind(accountId, userId).run()
  const token = generateToken()
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await hashToken(token), userId, now() + SESSION_TTL_S)
    .run()
  return { accountId, userId, email, token, cookie: `bz_session=${token}` }
}

export const secretIn = (html: string) => /bz_sk_[A-Za-z0-9]{32}/.exec(html)?.[0]
export const keyIn = (html: string) => /bz_pk_[A-Za-z0-9]{22}/.exec(html)?.[0]

/** A site made through the dashboard, as an owner would make it. */
export async function newSite(cookie: string, form: Record<string, string> = {}) {
  const res = await call('/sites', { cookie, form: { name: 'Docs', origins: 'https://docs.example', ...form } })
  const html = await res.text()
  return { res, html, key: keyIn(html)!, secret: secretIn(html)! }
}

/** Files a report through the public ingest route and waits for its after-work. */
export async function fileReport(
  site: { key: string; secret: string },
  patch: Record<string, unknown> = {},
  options: { screenshot?: Uint8Array; sub?: string; name?: string; email?: string } = {},
) {
  const identity = await signIdentity(
    {
      sub: options.sub ?? 'reporter',
      name: options.name ?? 'Dana Reyes',
      email: options.email ?? 'dana@host.example',
      iat: now(),
      exp: now() + 3600,
    },
    site.secret,
  )
  const body = new FormData()
  body.set(
    'payload',
    JSON.stringify({
      v: 1,
      site: site.key,
      identity,
      kind: 'bug',
      body: 'The save button does nothing.',
      page: { url: 'https://docs.example/editor', title: 'Editor' },
      screenshot: { mode: options.screenshot ? 'auto' : 'none' },
      diagnostics: { context: { build: 'v7' } },
      ...patch,
    }),
  )
  if (options.screenshot)
    body.set('screenshot', new File([new Uint8Array(options.screenshot)], 'shot.jpg', { type: 'image/jpeg' }))
  const ctx = createExecutionContext()
  const res = await app.fetch(
    new Request(`${BASE}/v1/reports`, { method: 'POST', headers: { Origin: 'https://docs.example' }, body }),
    { ...env, INGEST_BURST: open },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  const json = await res.json<{ ok: boolean; id: string }>()
  return { res, id: json.id }
}
