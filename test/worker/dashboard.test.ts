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
import { findIngestSite } from '../../src/worker/db/scoped'
import { siteIdentity } from '../../src/worker/identity'

import { BASE, call, newSite, now, open, owner, OWNER, secretIn } from './helpers'

const CLIENT = 'test-client.apps.googleusercontent.com' // vitest.config.ts
const CALLBACK = '/login/google/callback'

beforeEach(async () => {
  // Sign-in state is global, not per account, so each test starts without any.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM users WHERE email IN (?, ?)').bind(OWNER, 'moved@allowed.example'),
  ])
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>())!.n

const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.signature`

/** Begins a sign-in and returns what the browser would now hold and carry. */
async function begin(base = BASE) {
  const res = await call('/login/google', { base })
  const cookie = res.headers.get('set-cookie')!
  const target = new URL(res.headers.get('location')!)
  return { res, cookie, jar: cookie.split(';')[0]!, target, state: target.searchParams.get('state')! }
}

/** Stands in for Google's token endpoint, recording what the Worker sent it. */
function google(claims: Record<string, unknown> | null, status = 200) {
  const requests: URLSearchParams[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://oauth2.googleapis.com/token')
    requests.push(new URLSearchParams(String(init?.body)))
    return new Response(
      JSON.stringify(claims ? { id_token: idToken(claims), access_token: 'unused' } : { error: 'x' }),
      {
        status,
      },
    )
  })
  return requests
}

const person = (flow: { target: URL }, patch: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT,
  sub: '1090000000000000001',
  email: OWNER,
  email_verified: true,
  // A Google Workspace account for the address's own domain.
  hd: 'allowed.example',
  name: 'Owner Person',
  nonce: flow.target.searchParams.get('nonce'),
  iat: now(),
  exp: now() + 3600,
  ...patch,
})

/** A whole sign-in for these claims. */
async function signIn(patch: Record<string, unknown> = {}, base = BASE) {
  const flow = await begin(base)
  const requests = google(person(flow, patch))
  const res = await call(`${CALLBACK}?state=${flow.state}&code=the-code`, { cookie: flow.jar, base })
  return { flow, requests, res, session: res.headers.get('set-cookie')?.match(/(?:__Host-)?bz_session=[^;]+/)?.[0] }
}

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

describe('Google sign-in', () => {
  it('serves the sign-in page with a no-script policy and no caching', async () => {
    const res = await call('/login')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('href="/login/google"')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const css = await call('/dashboard.css')
    expect(css.headers.get('content-type')).toContain('text/css')
    // The emailed-link routes are gone.
    expect((await call('/login/confirm?token=x')).status).toBe(404)
    expect((await call('/login', { form: { email: OWNER } })).status).toBe(404)
  })

  it('sends the browser to Google with state, nonce, and a PKCE challenge it keeps in a cookie', async () => {
    const { res, cookie, target } = await begin()
    expect(res.status).toBe(302)
    expect(target.origin + target.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const q = target.searchParams
    expect(q.get('client_id')).toBe(CLIENT)
    expect(q.get('redirect_uri')).toBe(`${BASE}${CALLBACK}`)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('scope')).toBe('openid email profile')
    expect(q.get('code_challenge_method')).toBe('S256')
    for (const name of ['state', 'nonce', 'code_challenge']) expect(q.get(name)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(cookie).toMatch(/^bz_oauth=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43};/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=600')
    // The verifier stays in the cookie; only its hash goes to Google.
    const verifier = cookie.split(';')[0]!.split('.')[2]!
    expect(target.href).not.toContain(verifier)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(q.get('code_challenge')).toBe(challenge)
    // Two starts never share values.
    expect((await begin()).state).not.toBe(q.get('state'))
  })

  it('signs in, creating the user and one account, and stores only the session hash', async () => {
    const { flow, requests, res, session } = await signIn()
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/sites')
    const cookies = res.headers.get('set-cookie')!
    expect(cookies).toMatch(/bz_session=[A-Za-z0-9_-]{43};/)
    expect(cookies).toContain('HttpOnly')
    expect(cookies).toContain('SameSite=Lax')
    expect(cookies).toMatch(/bz_oauth=;/)

    // What went to Google: the code, the secret, and the verifier from the cookie.
    expect(requests).toHaveLength(1)
    const sent = requests[0]!
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('code')).toBe('the-code')
    expect(sent.get('client_id')).toBe(CLIENT)
    expect(sent.get('client_secret')).toBe('test-client-secret')
    expect(sent.get('redirect_uri')).toBe(`${BASE}${CALLBACK}`)
    expect(sent.get('code_verifier')).toBe(flow.jar.split('.')[2])

    const user = await env.DB.prepare('SELECT id, name, google_sub FROM users WHERE email = ?').bind(OWNER).first()
    expect(user).toMatchObject({ name: 'Owner Person', google_sub: '1090000000000000001' })
    expect(await count('SELECT count(*) AS n FROM memberships WHERE user_id = ?', user!.id)).toBe(1)
    const row = await env.DB.prepare('SELECT token_hash FROM sessions').first<{ token_hash: string }>()
    expect(row!.token_hash).toBe(await hashToken(session!.split('=')[1]!))

    const sites = await call('/sites', { cookie: session })
    expect(sites.status).toBe(200)
    expect(await sites.text()).toContain(OWNER)
    expect((await call('/login', { cookie: session })).headers.get('location')).toBe('/sites')

    // Signing in again is the same user and the same account.
    const accounts = await count('SELECT count(*) AS n FROM accounts')
    expect((await signIn()).res.status).toBe(303)
    expect(await count('SELECT count(*) AS n FROM users WHERE email = ?', OWNER)).toBe(1)
    expect(await count('SELECT count(*) AS n FROM accounts')).toBe(accounts)
    expect(await count('SELECT count(*) AS n FROM sessions')).toBe(2)
  })

  it('uses __Host- Secure cookies over HTTPS', async () => {
    const base = 'https://bugzap.test'
    const flow = await begin(base)
    expect(flow.cookie).toMatch(/^__Host-bz_oauth=/)
    expect(flow.cookie).toContain('Secure')
    expect(flow.target.searchParams.get('redirect_uri')).toBe(`${base}${CALLBACK}`)
    google(person(flow))
    const res = await call(`${CALLBACK}?state=${flow.state}&code=c`, { cookie: flow.jar, base })
    const session = res.headers.get('set-cookie')!.match(/__Host-bz_session=[^;]+/)![0]
    expect(res.headers.get('set-cookie')).toContain('Secure')
    expect((await call('/sites', { cookie: session, base })).status).toBe(200)
  })

  it('finishes only the sign-in this browser started', async () => {
    const mine = await begin()
    const other = await begin()
    const requests = google(person(mine))
    const attempts = [
      call(`${CALLBACK}?state=${other.state}&code=c`, { cookie: mine.jar }), // someone else's state
      call(`${CALLBACK}?state=${mine.state}&code=c`), // no cookie
      call(`${CALLBACK}?state=${mine.state}&code=c`, { cookie: 'bz_oauth=garbage' }),
      call(`${CALLBACK}?code=c`, { cookie: mine.jar }), // no state
      call(`${CALLBACK}?state=${mine.state}`, { cookie: mine.jar }), // no code
      call(`${CALLBACK}?state=${mine.state}&code=${'c'.repeat(3000)}`, { cookie: mine.jar }),
      call(`${CALLBACK}?state=${mine.state}&error=access_denied`, { cookie: mine.jar }),
      call(`${CALLBACK}?state=${other.state}&error=access_denied`, { cookie: mine.jar }),
    ]
    for (const attempt of attempts) {
      const res = await attempt
      expect(res.status).toBe(400)
      expect(res.headers.get('set-cookie') ?? '').not.toContain('bz_session')
    }
    expect(requests).toHaveLength(0)
    expect(await count('SELECT count(*) AS n FROM sessions')).toBe(0)
  })

  it('leaves a sign-in under way alone when a stray callback arrives with the wrong state', async () => {
    const mine = await begin()
    // A link someone else made the browser open: no state of ours, so nothing is spent.
    const stray = await call(`${CALLBACK}?error=access_denied&state=${generateToken()}`, { cookie: mine.jar })
    expect(stray.status).toBe(400)
    expect(stray.headers.get('set-cookie')).toBeNull()
    google(person(mine))
    expect((await call(`${CALLBACK}?state=${mine.state}&code=c`, { cookie: mine.jar })).status).toBe(303)
  })

  it('trusts an address only when Google is the authority for it', async () => {
    // An outside address on a personal Google account: verified once, perhaps long ago.
    for (const patch of [{ hd: undefined }, { hd: 'other.example' }, { hd: 'gmail.com' }, { hd: 7 }]) {
      const { res } = await signIn(patch)
      expect(res.status).toBe(400)
      expect(res.headers.get('set-cookie') ?? '').not.toContain('bz_session')
    }
    expect(await count('SELECT count(*) AS n FROM users WHERE email = ?', OWNER)).toBe(0)

    // Gmail needs no hosted domain, and a Workspace domain is matched without regard to case.
    const flow = await begin()
    google(person(flow, { email: 'someone@gmail.com', hd: undefined, sub: '77' }))
    const gmail = await call(`${CALLBACK}?state=${flow.state}&code=c`, {
      cookie: flow.jar,
      env: { SIGNUP_ALLOWLIST: 'someone@gmail.com' },
    })
    expect(gmail.status).toBe(303)
    await env.DB.prepare('DELETE FROM users WHERE email = ?').bind('someone@gmail.com').run()
    expect((await signIn({ hd: 'Allowed.Example' })).res.status).toBe(303)
  })

  it('refuses a token that is not a verified Google sign-in for this app and this attempt', async () => {
    const bad: Record<string, unknown>[] = [
      { aud: 'another-app.apps.googleusercontent.com' },
      { iss: 'https://accounts.evil.example' },
      { exp: now() - 1 },
      { nonce: 'a-different-nonce' },
      { nonce: undefined },
      { email_verified: false },
      { email_verified: undefined },
      { email: 'not an address' },
      { email: undefined },
      { sub: undefined },
      { sub: 12345 },
    ]
    for (const patch of bad) {
      const { res } = await signIn(patch)
      expect(res.status).toBe(400)
      expect(res.headers.get('set-cookie') ?? '').not.toContain('bz_session')
    }
    // Google answering with an error, or not at all, is the same refusal.
    for (const stub of [
      () => google(null, 400),
      () => vi.stubGlobal('fetch', async () => Promise.reject(new Error('down'))),
    ]) {
      const flow = await begin()
      stub()
      expect((await call(`${CALLBACK}?state=${flow.state}&code=c`, { cookie: flow.jar })).status).toBe(400)
    }
    expect(await count('SELECT count(*) AS n FROM sessions')).toBe(0)
    expect(await count('SELECT count(*) AS n FROM users WHERE email = ?', OWNER)).toBe(0)
  })

  it('turns away a Google account that is not on the allowlist, and stores nothing', async () => {
    const { res } = await signIn({ email: 'stranger@elsewhere.example', hd: 'elsewhere.example', sub: '2' })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('cannot sign in to Bugzap')
    expect(res.headers.get('set-cookie') ?? '').not.toContain('bz_session')
    expect(await count('SELECT count(*) AS n FROM users WHERE email = ?', 'stranger@elsewhere.example')).toBe(0)
  })

  it('knows a person by their Google id, not their address', async () => {
    const first = await signIn()
    const userId = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(OWNER).first<{ id: number }>())!
      .id

    // A different Google identity presenting the same address gets nothing.
    const imposter = await signIn({ sub: '999' })
    expect(imposter.res.status).toBe(403)
    expect(imposter.res.headers.get('set-cookie') ?? '').not.toContain('bz_session')
    expect(await count('SELECT count(*) AS n FROM sessions')).toBe(1)

    // The same identity with a new address keeps its account, and the address follows.
    expect((await call('/sites', { cookie: first.session })).status).toBe(200)
    const moved = await signIn({ email: 'moved@allowed.example' }, BASE)
    expect(moved.res.status).toBe(403) // not on the allowlist under the new address
    // ...and the sessions opened under the old address end with that refusal.
    expect((await call('/sites', { cookie: first.session })).status).toBe(303)
    expect(await count('SELECT count(*) AS n FROM sessions')).toBe(0)
    const allowed = { SIGNUP_ALLOWLIST: 'moved@allowed.example' }
    const flow = await begin()
    google(person(flow, { email: 'moved@allowed.example' }))
    const res = await call(`${CALLBACK}?state=${flow.state}&code=c`, { cookie: flow.jar, env: allowed })
    expect(res.status).toBe(303)
    expect(await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first()).toEqual({
      email: 'moved@allowed.example',
    })
    expect(await count('SELECT count(*) AS n FROM memberships WHERE user_id = ?', userId)).toBe(1)
  })

  it('ties an existing user who has never signed in with Google to the identity that arrives', async () => {
    const seeded = await owner(OWNER)
    const { res } = await signIn()
    expect(res.status).toBe(303)
    expect(await env.DB.prepare('SELECT id, google_sub FROM users WHERE email = ?').bind(OWNER).first()).toEqual({
      id: seeded.userId,
      google_sub: '1090000000000000001',
    })
    expect(await count('SELECT count(*) AS n FROM memberships WHERE user_id = ?', seeded.userId)).toBe(1)
  })

  it('creates one account when the same person signs in twice at once', async () => {
    const flows = [await begin(), await begin()]
    // One stub answers both exchanges; each attempt keeps its own nonce.
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const verifier = new URLSearchParams(String(init?.body)).get('code_verifier')
      const flow = flows.find((f) => f.jar.endsWith(verifier!))!
      return new Response(JSON.stringify({ id_token: idToken(person(flow)) }))
    })
    const before = await count('SELECT count(*) AS n FROM accounts')
    const results = await Promise.all(
      flows.map((flow) => call(`${CALLBACK}?state=${flow.state}&code=c`, { cookie: flow.jar })),
    )
    expect(results.map((r) => r.status)).toEqual([303, 303])
    expect(await count('SELECT count(*) AS n FROM users WHERE email = ?', OWNER)).toBe(1)
    expect(await count('SELECT count(*) AS n FROM accounts')).toBe(before + 1)
  })

  it('says so when Google sign-in is not configured', async () => {
    const res = await call('/login/google', { env: { GOOGLE_CLIENT_ID: '' } })
    expect(res.status).toBe(503)
    expect(res.headers.get('location')).toBeNull()
  })

  it('refuses posts from another origin or with no origin', async () => {
    const me = await owner()
    for (const origin of ['https://evil.example', null])
      expect((await call('/logout', { method: 'POST', cookie: me.cookie, origin })).status).toBe(403)
    expect((await call('/sites', { cookie: me.cookie })).status).toBe(200)
  })

  it('accepts a browser post whose origin is withheld, but only when the browser calls it same-origin', async () => {
    const post = (headers: Record<string, string>) =>
      app.fetch(
        new Request(`${BASE}/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
          body: '',
        }),
        env,
        createExecutionContext(),
      )
    expect((await post({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(303)
    expect((await post({ 'Sec-Fetch-Site': 'same-origin' })).status).toBe(303)
    for (const site of ['cross-site', 'same-site', 'none'])
      expect((await post({ Origin: 'null', 'Sec-Fetch-Site': site })).status).toBe(403)
    expect((await post({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(403)
    expect((await post({ Origin: 'null' })).status).toBe(403)
  })

  it('ends sessions when an address leaves the allowlist', async () => {
    const { session } = await signIn()
    expect((await call('/sites', { cookie: session, env: { SIGNUP_ALLOWLIST: '@team.example' } })).status).toBe(303)
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

  it('redirects without a live session, and sign-out ends it on the server', async () => {
    const me = await owner()
    for (const path of ['/', '/sites', '/sites/bz_pk_0000000000000000000000']) {
      const res = await call(path)
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('/login')
    }
    expect((await call('/sites', { cookie: `bz_session=${generateToken()}` })).status).toBe(303)
    expect((await call('/sites', { cookie: me.cookie })).status).toBe(200)

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
