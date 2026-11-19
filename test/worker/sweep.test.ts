import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { generateToken, hashToken } from '../../src/worker/auth/tokens'
import { findIngestSite } from '../../src/worker/db/scoped'
import { ORPHAN_AGE_S, sweep } from '../../src/worker/sweep'
import { jpeg } from '../core/fixtures/images'
import { call, fileReport, newSite, now, owner } from './helpers'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const exists = async (sql: string, ...binds: unknown[]) =>
  !!(await env.DB.prepare(sql)
    .bind(...binds)
    .first())

it('removes expired sign-in state and keeps what is live', async () => {
  const me = await owner()
  const stale = await owner()
  await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?')
    .bind(now() - 1, stale.userId)
    .run()
  const [liveLink, deadLink] = [await hashToken(generateToken()), await hashToken(generateToken())]
  await env.DB.batch([
    env.DB.prepare('INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(
      liveLink,
      me.userId,
      now() + 600,
    ),
    env.DB.prepare('INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(
      deadLink,
      me.userId,
      now() - 600,
    ),
    // Three addresses that asked for a link: long ago, long ago with a live link, and just now.
    env.DB.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)').bind('gone@sweep.example', now() - 90000),
    env.DB.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)').bind('waiting@sweep.example', now() - 90000),
    env.DB.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)').bind('fresh@sweep.example', now()),
    env.DB.prepare(
      'INSERT INTO login_tokens (token_hash, user_id, expires_at) SELECT ?, id, ? FROM users WHERE email = ?',
    ).bind(await hashToken(generateToken()), now() + 600, 'waiting@sweep.example'),
  ])

  const counts = await sweep(env, now())
  expect(counts.login_tokens).toBeGreaterThanOrEqual(1)
  expect(counts.sessions).toBeGreaterThanOrEqual(1)
  expect(await exists('SELECT 1 FROM login_tokens WHERE token_hash = ?', liveLink)).toBe(true)
  expect(await exists('SELECT 1 FROM login_tokens WHERE token_hash = ?', deadLink)).toBe(false)
  expect(await exists('SELECT 1 FROM sessions WHERE user_id = ?', me.userId)).toBe(true)
  expect(await exists('SELECT 1 FROM sessions WHERE user_id = ?', stale.userId)).toBe(false)
  expect(await exists('SELECT 1 FROM users WHERE email = ?', 'gone@sweep.example')).toBe(false)
  expect(await exists('SELECT 1 FROM users WHERE email = ?', 'waiting@sweep.example')).toBe(true)
  expect(await exists('SELECT 1 FROM users WHERE email = ?', 'fresh@sweep.example')).toBe(true)
  // An owner whose session expired still has their account.
  expect(await exists('SELECT 1 FROM users WHERE id = ?', stale.userId)).toBe(true)
  expect((await call('/sites', { cookie: me.cookie })).status).toBe(200)
})

it('drops a rotated-out secret only after its grace period', async () => {
  const me = await owner()
  const site = await newSite(me.cookie)
  await call(`/sites/${site.key}/rotate`, { method: 'POST', cookie: me.cookie })
  await sweep(env, now())
  expect((await findIngestSite(env.DB, site.key))!.previous_secret_cipher).not.toBeNull()
  await sweep(env, now() + ORPHAN_AGE_S + 1)
  const after = (await findIngestSite(env.DB, site.key))!
  expect(after.previous_secret_cipher).toBeNull()
  expect(after.previous_secret_expires_at).toBeNull()
  expect(after.secret_cipher).toBeTruthy()
})

it('deletes old unclaimed images, and never a claimed or a recent one', async () => {
  const me = await owner()
  const site = await newSite(me.cookie)
  const { id } = await fileReport(site, {}, { screenshot: jpeg() })
  const claimed = (await env.DB.prepare(
    'SELECT a.object_key FROM attachments a JOIN reports r ON r.id = a.report_id WHERE r.public_id = ?',
  )
    .bind(id)
    .first<{ object_key: string }>())!.object_key
  const orphan = `sweep-test/${id}/orphan.jpg`
  await env.SHOTS.put(orphan, jpeg())

  // Nothing is old enough yet.
  expect((await sweep(env, now())).orphan_images).toBe(0)
  expect(await env.SHOTS.head(orphan)).not.toBeNull()

  // A day later the orphan goes and the report's screenshot stays.
  await env.DB.prepare('DELETE FROM sweep_state').run()
  const later = await sweep(env, now() + ORPHAN_AGE_S + 60)
  expect(later.orphan_images).toBeGreaterThanOrEqual(1)
  expect(await env.SHOTS.head(orphan)).toBeNull()
  expect(await env.SHOTS.head(claimed)).not.toBeNull()
})

it('keeps going when one step fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const broken = { ...env, SHOTS: { list: async () => Promise.reject(new Error('R2 is down')) } } as unknown as Env
  const counts = await sweep(broken, now())
  expect(counts.orphan_images).toBe(-1)
  expect(counts.sessions).toBeGreaterThanOrEqual(0)
})
