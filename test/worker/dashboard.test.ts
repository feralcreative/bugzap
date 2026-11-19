import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId } from '../../src/core/ids'
import { signIdentity, verifyIdentity } from '../../src/core/identity'
import { ORIGINS_MAX, SECRET_GRACE_S, SITES_MAX } from '../../src/core/policy'
import app from '../../src/worker'
import { isAllowed, normalizeEmail } from '../../src/worker/auth/allowlist'
import { generateToken, hashToken } from '../../src/worker/auth/tokens'
import { decryptSiteSecret } from '../../src/worker/crypto'
import { LOGIN_TOKEN_TTL_S, LOGIN_TOKENS_MAX, SESSION_TTL_S } from '../../src/worker/db/auth'
import { findIngestSite } from '../../src/worker/db/scoped'
import { siteIdentity } from '../../src/worker/identity'

import { BASE, call, newSite, now, open, owner, OWNER, secretIn } from './helpers'

let mail: string[]
beforeEach(async () => {
  mail = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    mail.push(args.join(' '))
  })
  // Sign-in state is global, not per account, so each test starts without any.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_tokens'),
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM users WHERE email = ?').bind(OWNER),
  ])
})
afterEach(() => vi.restoreAllMocks())

const linkToken = () => /\/login\/confirm\?token=([A-Za-z0-9_-]{43})/.exec(mail.join('\n'))?.[1]
const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>())!.n

describe('allowlist', () => {
  it('normalizes addresses and refuses malformed ones', () => {
    expect(normalizeEmail('  Owner@Allowed.Example ')).toBe('owner@allowed.example')
    for (const bad of ['', 'nobody', 'a@b', 'a b@c.example', 'a@b@c.example', '<a@c.example>', 42, null])
      expect(normalizeEmail(bad)).toBeNull()
    expect(normalizeEmail(`${'a'.repeat(250)}@c.example`)).toBeNull()
  })

  it('admits listed addresses and whole domains, and nobody when empty', () => {
    const list = 'Owner@allowed.example, @team.example\nsecond@other.example'
    expect(isAllowed('owner@allowed.example', list)).toBe(true)
    expect(isAllowed('anyone@team.example', list)).toBe(true)
    expect(isAllowed('second@other.example', list)).toBe(true)
    expect(isAllowed('other@allowed.example', list)).toBe(false)
    expect(isAllowed('anyone@sub.team.example', list)).toBe(false)
    expect(isAllowed('anyone@notteam.example', list)).toBe(false)
    expect(isAllowed('owner@allowed.example', '')).toBe(false)
    expect(isAllowed('owner@allowed.example', undefined)).toBe(false)
  })
})

describe('magic-link sign-in', () => {
  it('serves the form with a no-script policy and no caching', async () => {
    const res = await call('/login')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const css = await call('/dashboard.css')
    expect(css.headers.get('content-type')).toContain('text/css')
  })

  it('refuses posts from another origin or with no origin', async () => {
    for (const origin of ['https://evil.example', null]) {
      const res = await call('/login', { form: { email: OWNER }, origin })
      expect(res.status).toBe(403)
    }
    expect(mail).toHaveLength(0)
    expect(await count('SELECT count(*) AS n FROM login_tokens')).toBe(0)
  })

  it('accepts a browser post whose origin is withheld, but only when the browser calls it same-origin', async () => {
    const post = (headers: Record<string, string>) =>
      app.fetch(
        new Request(`${BASE}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
          body: `email=${encodeURIComponent(OWNER)}`,
        }),
        { ...env, LOGIN_BURST: open },
        createExecutionContext(),
      )
    expect((await post({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200)
    expect((await post({ 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200)
    for (const site of ['cross-site', 'same-site', 'none'])
      expect((await post({ Origin: 'null', 'Sec-Fetch-Site': site })).status).toBe(403)
    expect((await post({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(403)
    expect((await post({ Origin: 'null' })).status).toBe(403)
  })

  it('rejects a malformed address', async () => {
    const res = await call('/login', { form: { email: 'not an address' } })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Enter a valid email address.')
  })

  it('answers an address off the allowlist exactly like one on it, and stores nothing', async () => {
    const refused = await call('/login', { form: { email: 'stranger@elsewhere.example' } })
    const allowed = await call('/login', { form: { email: OWNER } })
    expect(refused.status).toBe(200)
    expect(await refused.text()).toBe(await allowed.text())
    expect(await count('SELECT count(*) AS n FROM users WHERE email = ?', 'stranger@elsewhere.example')).toBe(0)
    expect(mail).toHaveLength(1)
    expect(mail[0]).toContain(`To: ${OWNER}`)
  })

  const memberships = () =>
    count('SELECT count(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', OWNER)

  it('stores only the token hash, and creates no account until a link is used', async () => {
    await call('/login', { form: { email: ` ${OWNER.toUpperCase()} ` } })
    const first = linkToken()!
    mail.length = 0
    await call('/login', { form: { email: OWNER } })
    const second = linkToken()!
    expect(await count('SELECT count(*) AS n FROM users WHERE email = ?', OWNER)).toBe(1)
    expect(await memberships()).toBe(0)
    const stored = await env.DB.prepare('SELECT token_hash, expires_at FROM login_tokens').all<{
      token_hash: string
      expires_at: number
    }>()
    expect(stored.results).toHaveLength(2)
    expect(stored.results.map((r) => r.token_hash)).toContain(await hashToken(first))
    expect(JSON.stringify(stored.results)).not.toContain(first)
    expect(stored.results[0]!.expires_at).toBeLessThanOrEqual(now() + LOGIN_TOKEN_TTL_S)

    // Two links used at the same moment still make exactly one account.
    const accountsBefore = await count('SELECT count(*) AS n FROM accounts')
    const both = await Promise.all([first, second].map((token) => call('/login/confirm', { form: { token } })))
    expect(both.map((r) => r.status)).toEqual([303, 303])
    expect(await memberships()).toBe(1)
    expect(await count('SELECT count(*) AS n FROM accounts')).toBe(accountsBefore + 1)
    expect(await count('SELECT count(*) AS n FROM sessions')).toBe(2)
  })

  it('answers a storage failure like any other request', async () => {
    const broken = { ...env.DB, batch: async () => Promise.reject(new Error('D1 is down')) } as unknown as D1Database
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call('/login', { form: { email: OWNER }, env: { DB: broken } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(
      await (await call('/login', { form: { email: 'stranger@elsewhere.example' } })).text(),
    )
  })

  it('ends sessions and unused links when an address leaves the allowlist', async () => {
    await call('/login', { form: { email: OWNER } })
    const token = linkToken()!
    const closed = { SIGNUP_ALLOWLIST: '@team.example' }
    const res = await call('/login/confirm', { form: { token }, env: closed })
    const session = res.headers.get('set-cookie')?.split(';')[0]
    expect((await call('/sites', { cookie: session, env: closed })).status).toBe(303)
    expect((await call('/sites', { cookie: session, env: { SIGNUP_ALLOWLIST: '' } })).status).toBe(303)
    expect((await call('/sites', { cookie: session })).status).toBe(200)
  })

  it('does not let a member in', async () => {
    const me = await owner()
    await env.DB.prepare("UPDATE memberships SET role = 'member' WHERE user_id = ?").bind(me.userId).run()
    expect((await call('/sites', { cookie: me.cookie })).status).toBe(303)
    expect(
      (await call('/sites', { cookie: me.cookie, form: { name: 'x', origins: 'https://x.example' } })).status,
    ).toBe(303)
    expect(await count('SELECT count(*) AS n FROM sites WHERE account_id = ?', me.accountId)).toBe(0)
  })

  it('shows a button on GET without spending the link, then signs in once on POST', async () => {
    await call('/login', { form: { email: OWNER } })
    const token = linkToken()!
    for (let i = 0; i < 3; i++) {
      const page = await call(`/login/confirm?token=${token}`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('action="/login/confirm"')
    }
    const res = await call('/login/confirm', { form: { token } })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/sites')
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toMatch(/^bz_session=[A-Za-z0-9_-]{43};/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    const session = cookie.split(';')[0]!
    // Only the hash of the session token is stored.
    const row = await env.DB.prepare('SELECT token_hash FROM sessions').first<{ token_hash: string }>()
    expect(row!.token_hash).toBe(await hashToken(session.split('=')[1]!))

    const sites = await call('/sites', { cookie: session })
    expect(sites.status).toBe(200)
    expect(await sites.text()).toContain(OWNER)

    const again = await call('/login/confirm', { form: { token } })
    expect(again.status).toBe(400)
    expect(again.headers.get('set-cookie')).toBeNull()
    expect((await call(`/login/confirm?token=${token}`)).status).toBe(400)
    expect(await count('SELECT count(*) AS n FROM sessions')).toBe(1)
  })

  it('uses a __Host- Secure cookie over HTTPS', async () => {
    const base = 'https://bugzap.test'
    await call('/login', { form: { email: OWNER }, base })
    expect(mail.join('\n')).toContain('https://bugzap.test/login/confirm?token=')
    const res = await call('/login/confirm', { form: { token: linkToken()! }, base })
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toMatch(/^__Host-bz_session=/)
    expect(cookie).toContain('Secure')
    expect((await call('/sites', { cookie: cookie.split(';')[0], base })).status).toBe(200)
  })

  it('refuses expired, unknown, and malformed tokens', async () => {
    await call('/login', { form: { email: OWNER } })
    const token = linkToken()!
    await env.DB.prepare('UPDATE login_tokens SET expires_at = ?')
      .bind(now() - 1)
      .run()
    for (const bad of [token, generateToken(), 'short', '']) {
      expect((await call(`/login/confirm?token=${bad}`)).status).toBe(400)
      const res = await call('/login/confirm', { form: { token: bad } })
      expect(res.status).toBe(400)
      expect(res.headers.get('set-cookie')).toBeNull()
    }
    expect(await count('SELECT count(*) AS n FROM sessions')).toBe(0)
  })

  it('honours the burst limit and caps live links per address', async () => {
    const limited = await call('/login', {
      form: { email: OWNER },
      env: { LOGIN_BURST: { limit: async () => ({ success: false }) } },
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(mail).toHaveLength(0)

    for (let i = 0; i < LOGIN_TOKENS_MAX + 2; i++)
      expect((await call('/login', { form: { email: OWNER } })).status).toBe(200)
    expect(mail).toHaveLength(LOGIN_TOKENS_MAX)
    expect(await count('SELECT count(*) AS n FROM login_tokens')).toBe(LOGIN_TOKENS_MAX)
  })

  it('redirects without a live session, and sign-out ends it on the server', async () => {
    const me = await owner()
    for (const path of ['/', '/sites', '/sites/bz_pk_0000000000000000000000']) {
      const res = await call(path)
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('/login')
    }
    expect((await call('/sites', { cookie: `bz_session=${generateToken()}` })).status).toBe(303)
    expect((await call('/sites', { cookie: me.cookie })).status).toBe(200)
    expect((await call('/login', { cookie: me.cookie })).headers.get('location')).toBe('/sites')

    const out = await call('/logout', { method: 'POST', cookie: me.cookie })
    expect(out.status).toBe(303)
    expect(out.headers.get('set-cookie')).toMatch(/^bz_session=;/)
    expect((await call('/sites', { cookie: me.cookie })).status).toBe(303)

    const stale = await owner()
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?')
      .bind(now() - 1, stale.userId)
      .run()
    expect((await call('/sites', { cookie: stale.cookie })).status).toBe(303)
  })
})

describe('sites', () => {
  it('creates a site, shows the secret once, and stores it only encrypted', async () => {
    const me = await owner()
    const { res, html, key, secret } = await newSite(me.cookie, {
      name: '  Docs <script>alert(1)</script> ',
      origins: 'https://Docs.example/path\n\nhttp://localhost:2834\nhttps://docs.example',
    })
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(secret).toBeTruthy()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')

    const row = await env.DB.prepare('SELECT * FROM sites WHERE public_key = ?').bind(key).first<{
      id: number
      account_id: number
      name: string
      secret_cipher: string
    }>()
    expect(row).toMatchObject({ account_id: me.accountId, name: 'Docs <script>alert(1)</script>' })
    expect(row!.secret_cipher).not.toContain(secret)
    expect(await decryptSiteSecret(row!.secret_cipher, env.SITE_KEK, key)).toBe(secret)
    const origins = await env.DB.prepare('SELECT origin FROM site_origins WHERE site_id = ? ORDER BY origin')
      .bind(row!.id)
      .all<{ origin: string }>()
    expect(origins.results.map((r) => r.origin)).toEqual(['http://localhost:2834', 'https://docs.example'])

    const later = await (await call(`/sites/${key}`, { cookie: me.cookie })).text()
    expect(later).toContain(key)
    expect(secretIn(later)).toBeUndefined()
    expect(await (await call('/sites', { cookie: me.cookie })).text()).toContain(`/sites/${key}`)
  })

  it('refuses bad names and origins without creating anything', async () => {
    const me = await owner()
    const cases: Record<string, string>[] = [
      { name: '   ' },
      { name: 'x'.repeat(81) },
      { origins: 'http://plain-http.example' },
      { origins: 'https://ok.example\nnot an origin' },
      { origins: '  \n ' },
      { origins: Array.from({ length: ORIGINS_MAX + 1 }, (_, i) => `https://h${i}.example`).join('\n') },
    ]
    for (const form of cases) {
      const { res, secret } = await newSite(me.cookie, form)
      expect(res.status).toBe(400)
      expect(secret).toBeUndefined()
    }
    expect(await count('SELECT count(*) AS n FROM sites WHERE account_id = ?', me.accountId)).toBe(0)
    expect(
      (await call('/sites', { cookie: me.cookie, form: { name: 'x', origins: 'https://x.example' }, origin: null }))
        .status,
    ).toBe(403)
  })

  it('stops at the per-account site limit', async () => {
    const me = await owner()
    for (let i = 0; i < SITES_MAX; i++) expect((await newSite(me.cookie)).res.status).toBe(201)
    const { res, secret } = await newSite(me.cookie)
    expect(res.status).toBe(409)
    expect(secret).toBeUndefined()
    expect(await count('SELECT count(*) AS n FROM sites WHERE account_id = ?', me.accountId)).toBe(SITES_MAX)
  })

  it('rotates the secret and keeps the previous one valid for the grace period only', async () => {
    const me = await owner()
    const { key, secret: first } = await newSite(me.cookie)
    const res = await call(`/sites/${key}/rotate`, { method: 'POST', cookie: me.cookie })
    expect(res.status).toBe(200)
    const second = secretIn(await res.text())!
    expect(second).not.toBe(first)

    const site = (await findIngestSite(env.DB, key))!
    expect(await decryptSiteSecret(site.secret_cipher, env.SITE_KEK, key)).toBe(second)
    expect(site.previous_secret_expires_at).toBeGreaterThan(now() + SECRET_GRACE_S - 60)
    expect(site.previous_secret_expires_at).toBeLessThanOrEqual(now() + SECRET_GRACE_S)
    const claims = { sub: 'reporter', iat: now(), exp: now() + 3600 }
    const oldToken = await signIdentity(claims, first)
    expect((await siteIdentity(env, site, oldToken, now())).sub).toBe('reporter')
    expect((await siteIdentity(env, site, await signIdentity(claims, second), now())).sub).toBe('reporter')
    await expect(siteIdentity(env, site, oldToken, site.previous_secret_expires_at! + 1)).rejects.toThrow()

    // A second rotation keeps only the secret it replaced.
    const third = secretIn(await (await call(`/sites/${key}/rotate`, { method: 'POST', cookie: me.cookie })).text())!
    const rotated = (await findIngestSite(env.DB, key))!
    await expect(siteIdentity(env, rotated, oldToken, now())).rejects.toThrow()
    expect((await verifyIdentity(await signIdentity(claims, third), [third], now())).ok).toBe(true)
    expect((await siteIdentity(env, rotated, await signIdentity(claims, second), now())).sub).toBe('reporter')
  })

  it('adds and removes origins', async () => {
    const me = await owner()
    const { key } = await newSite(me.cookie)
    const list = async () =>
      (
        await env.DB.prepare(
          'SELECT origin FROM site_origins o JOIN sites s ON s.id = o.site_id WHERE s.public_key = ? ORDER BY origin',
        )
          .bind(key)
          .all<{ origin: string }>()
      ).results.map((r) => r.origin)

    const added = await call(`/sites/${key}/origins`, {
      cookie: me.cookie,
      form: { origin: ' https://App.example/x ' },
    })
    expect(added.status).toBe(303)
    expect(added.headers.get('location')).toBe(`/sites/${key}`)
    await call(`/sites/${key}/origins`, { cookie: me.cookie, form: { origin: 'https://app.example' } })
    expect(await list()).toEqual(['https://app.example', 'https://docs.example'])

    const bad = await call(`/sites/${key}/origins`, { cookie: me.cookie, form: { origin: 'http://app.example' } })
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('is not an origin Bugzap can accept')

    await call(`/sites/${key}/origins/remove`, { cookie: me.cookie, form: { origin: 'https://docs.example' } })
    expect(await list()).toEqual(['https://app.example'])

    for (let i = 0; i < ORIGINS_MAX - 1; i++)
      await call(`/sites/${key}/origins`, { cookie: me.cookie, form: { origin: `https://h${i}.example` } })
    expect(await list()).toHaveLength(ORIGINS_MAX)
    const full = await call(`/sites/${key}/origins`, {
      cookie: me.cookie,
      form: { origin: 'https://one-more.example' },
    })
    expect(full.status).toBe(400)
    expect(await list()).toHaveLength(ORIGINS_MAX)
  })

  it('accepts a report signed with the secret the dashboard showed', async () => {
    const me = await owner()
    const { key, secret } = await newSite(me.cookie)
    const identity = await signIdentity({ sub: 'reporter', iat: now(), exp: now() + 3600 }, secret)
    const body = new FormData()
    body.set(
      'payload',
      JSON.stringify({
        v: 1,
        site: key,
        identity,
        kind: 'bug',
        body: 'The save button does nothing.',
        page: { url: 'https://docs.example/editor', title: 'Editor' },
        screenshot: { mode: 'none' },
        diagnostics: {},
      }),
    )
    const post = (origin: string) =>
      app.fetch(
        new Request(`${BASE}/v1/reports`, { method: 'POST', headers: { Origin: origin }, body }),
        { ...env, INGEST_BURST: open },
        createExecutionContext(),
      )
    expect((await post('https://docs.example')).status).toBe(201)
    expect((await post('https://elsewhere.example')).status).toBe(403)
    expect(await count('SELECT count(*) AS n FROM reports WHERE account_id = ?', me.accountId)).toBe(1)
  })
})

describe('concurrent rotation', () => {
  it('never shows a secret that is not the current one', async () => {
    const me = await owner()
    const { key } = await newSite(me.cookie)
    const results = await Promise.all(
      [1, 2, 3].map(() => call(`/sites/${key}/rotate`, { method: 'POST', cookie: me.cookie })),
    )
    const site = (await findIngestSite(env.DB, key))!
    const current = await decryptSiteSecret(site.secret_cipher, env.SITE_KEK, key)
    const shown: string[] = []
    for (const res of results) {
      const secret = secretIn(await res.text())
      expect([200, 409]).toContain(res.status)
      expect(!!secret).toBe(res.status === 200)
      if (secret) shown.push(secret)
    }
    expect(shown).toEqual([current])
  })
})

describe('cross-account isolation', () => {
  it("answers 404 for another account's site on every route and changes nothing", async () => {
    const mine = await owner()
    const theirs = await owner()
    const { key, secret } = await newSite(theirs.cookie)
    const before = await env.DB.prepare('SELECT * FROM sites WHERE public_key = ?').bind(key).first()

    const attempts = [
      call(`/sites/${key}`, { cookie: mine.cookie }),
      call(`/sites/${key}/rotate`, { method: 'POST', cookie: mine.cookie }),
      call(`/sites/${key}/origins`, { cookie: mine.cookie, form: { origin: 'https://evil.example' } }),
      call(`/sites/${key}/origins/remove`, { cookie: mine.cookie, form: { origin: 'https://docs.example' } }),
    ]
    const unknown = await call('/sites/bz_pk_0000000000000000000000', { cookie: mine.cookie })
    const unknownBody = await unknown.text()
    for (const attempt of attempts) {
      const res = await attempt
      expect(res.status).toBe(404)
      const html = await res.text()
      expect(html).toBe(unknownBody)
      expect(html).not.toContain(key)
      expect(secretIn(html)).toBeUndefined()
    }

    expect(await env.DB.prepare('SELECT * FROM sites WHERE public_key = ?').bind(key).first()).toEqual(before)
    expect(await count('SELECT count(*) AS n FROM site_origins WHERE account_id = ?', theirs.accountId)).toBe(1)
    expect(await count('SELECT count(*) AS n FROM site_origins WHERE account_id = ?', mine.accountId)).toBe(0)
    expect(await (await call('/sites', { cookie: mine.cookie })).text()).not.toContain(key)
    // The owner's own view still works and the secret still decrypts.
    expect((await call(`/sites/${key}`, { cookie: theirs.cookie })).status).toBe(200)
    const site = (await findIngestSite(env.DB, key))!
    expect(await decryptSiteSecret(site.secret_cipher, env.SITE_KEK, key)).toBe(secret)
  })

  it('counts the site limit per account', async () => {
    const full = await owner()
    for (let i = 0; i < SITES_MAX; i++) await newSite(full.cookie)
    const other = await owner()
    expect((await newSite(other.cookie)).res.status).toBe(201)
  })
})
