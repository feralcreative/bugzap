import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signIdentity } from '../../src/core/identity'
import { GUEST_SITE_LIMIT } from '../../src/core/policy'
import app from '../../src/worker'
import { generateToken } from '../../src/worker/auth/tokens'
import { decryptSiteSecret } from '../../src/worker/crypto'
import { findIngestSite } from '../../src/worker/db/scoped'
import { guestSubject } from '../../src/worker/identity'
import { BASE, call, fileReport, keyIn, newSite, now, open, owner, secretIn } from './helpers'

const ORIGIN = 'https://docs.example'
const PAGE = `${ORIGIN}/editor`

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const anchor = {
  v: 1,
  attrs: [{ depth: 0, name: 'data-bugzap-id', value: 'save' }],
  selector: '#save',
  tag: 'button',
  rect: { x: 0, y: 0, w: 10, h: 10 },
  offset: { fx: 0.5, fy: 0.5 },
  page: { x: 5, y: 5 },
  viewport: { w: 1280, h: 800, dpr: 1, sx: 0, sy: 0 },
}

async function send(
  key: string,
  patch: Record<string, unknown>,
  options: { origin?: string; ip?: string; env?: Partial<Env> } = {},
) {
  const body = new FormData()
  body.set(
    'payload',
    JSON.stringify({
      v: 1,
      site: key,
      kind: 'bug',
      body: 'The total is wrong by one cent.',
      page: { url: PAGE, title: 'Editor' },
      pin: anchor,
      screenshot: { mode: 'none' },
      diagnostics: {},
      ...patch,
    }),
  )
  const ctx = createExecutionContext()
  const res = await app.fetch(
    new Request(`${BASE}/v1/reports`, {
      method: 'POST',
      headers: { Origin: options.origin ?? ORIGIN, ...(options.ip && { 'CF-Connecting-IP': options.ip }) },
      body,
    }),
    { ...env, INGEST_BURST: open, ...options.env },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return { res, json: await res.clone().json<{ ok: boolean; id?: string; error?: string }>() }
}

function pins(key: string, authorization: string | null) {
  return app.fetch(
    new Request(`${BASE}/v1/pins?site=${key}&page=${encodeURIComponent(PAGE)}`, {
      headers: { Origin: ORIGIN, ...(authorization && { Authorization: authorization }) },
    }),
    { ...env, PINS_READ: open },
    createExecutionContext(),
  )
}

const guestSite = async () => {
  const me = await owner()
  const site = await newSite(me.cookie, { identity: 'guest' })
  return { me, key: site.key, html: site.html, res: site.res }
}

describe('a site open to guests', () => {
  it('is created with nothing to copy but the embed', async () => {
    const { key, html, res } = await guestSite()
    expect(res.status).toBe(201)
    expect(secretIn(html)).toBeUndefined()
    expect(html).toContain(`Bugzap(&#39;init&#39;, { site: &#39;${key}&#39; })`)
    expect(html).not.toContain('SERVER_SIGNED_IDENTITY_TOKEN')
    expect((await findIngestSite(env.DB, key))!.identity_mode).toBe('guest')
    // Leaving the choice out is the same as choosing guests.
    const me = await owner()
    const plain = await call('/sites', { cookie: me.cookie, form: { name: 'Plain', origins: ORIGIN } })
    expect((await findIngestSite(env.DB, keyIn(await plain.text())!))!.identity_mode).toBe('guest')
  })

  it('takes a report from a guest, with the name and email they typed, stored under a hash of their id', async () => {
    const { me, key } = await guestSite()
    const guest = generateToken()
    const { res, json } = await send(key, {
      guest,
      reporter: { name: '  Dana   Reyes ', email: ' dana@example.com ' },
    })
    expect(res.status).toBe(201)
    const reporter = await env.DB.prepare(
      'SELECT p.subject, p.name, p.email FROM reporters p JOIN reports r ON r.reporter_id = p.id WHERE r.public_id = ?',
    )
      .bind(json.id)
      .first<{ subject: string; name: string; email: string }>()
    expect(reporter).toEqual({ subject: await guestSubject(guest), name: 'Dana Reyes', email: 'dana@example.com' })
    expect(reporter!.subject).toMatch(/^guest:[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(reporter)).not.toContain(guest)

    // The owner sees who it is from, and that nothing vouches for it.
    const detail = await (await call(`/reports/${json.id}`, { cookie: me.cookie })).text()
    expect(detail).toContain('Dana Reyes (guest)')
    expect(detail).toContain('have not been')
    expect(await (await call(`/sites/${key}/reports`, { cookie: me.cookie })).text()).toContain('Dana Reyes (guest)')

    // Anonymous is fine too.
    const bare = await send(key, { guest: generateToken() })
    expect(bare.res.status).toBe(201)
    expect(await (await call(`/reports/${bare.json.id}`, { cookie: me.cookie })).text()).toContain('A guest (guest)')
  })

  it('refuses a malformed guest id or email, and a report with no reporter at all', async () => {
    const { key } = await guestSite()
    for (const guest of ['short', 'x'.repeat(44), 42, null, ''])
      expect((await send(key, { guest })).res.status).toBe(401)
    expect((await send(key, {})).res.status).toBe(401)
    const bad = await send(key, { guest: generateToken(), reporter: { email: 'not an address' } })
    expect(bad.res.status).toBe(400)
    expect(bad.json.error).toBe('invalid_payload')
    // The origin allowlist applies to guests exactly as to everyone.
    expect((await send(key, { guest: generateToken() }, { origin: 'https://evil.example' })).res.status).toBe(403)
  })

  it('shows a guest their own pins and nobody else’s', async () => {
    const { key } = await guestSite()
    const [mine, theirs] = [generateToken(), generateToken()]
    const first = await send(key, { guest: mine })
    await send(key, { guest: theirs, body: 'Someone else wrote this.' })

    const res = await pins(key, `Guest ${mine}`)
    expect(res.status).toBe(200)
    const body = await res.json<{ pins: { id: string; body: string }[] }>()
    expect(body.pins.map((p) => p.id)).toEqual([first.json.id])
    expect(JSON.stringify(body)).not.toContain('Someone else')

    expect((await (await pins(key, `Guest ${generateToken()}`)).json<{ pins: unknown[] }>()).pins).toEqual([])
    for (const bad of [null, 'Guest short', `Bearer ${mine}`, `View ${mine}`])
      expect((await pins(key, bad)).status).toBe(401)
  })

  it('still honours a signed token, and keeps the two kinds of reporter apart', async () => {
    const me = await owner()
    const site = await newSite(me.cookie) // signed, so the secret is known
    await call(`/sites/${site.key}/identity`, { cookie: me.cookie, form: { mode: 'guest' } })
    expect((await findIngestSite(env.DB, site.key))!.identity_mode).toBe('guest')

    const signed = await fileReport(site, { pin: anchor })
    expect(signed.res.status).toBe(201)
    const guest = generateToken()
    expect((await send(site.key, { guest })).res.status).toBe(201)

    // A host cannot sign a token for a guest's subject and read that guest's pins.
    const forged = await signIdentity({ sub: await guestSubject(guest), iat: now(), exp: now() + 600 }, site.secret)
    expect((await pins(site.key, `Bearer ${forged}`)).status).toBe(401)
    expect((await send(site.key, { identity: forged })).res.status).toBe(401)
    // A guest's name and email are ignored beside a real token.
    const both = await send(site.key, {
      identity: await signIdentity({ sub: 'u1', name: 'Real Name', iat: now(), exp: now() + 600 }, site.secret),
      guest,
      reporter: { name: 'Fake Name' },
    })
    expect(
      await env.DB.prepare(
        'SELECT p.subject, p.name FROM reporters p JOIN reports r ON r.reporter_id = p.id WHERE r.public_id = ?',
      )
        .bind(both.json.id)
        .first(),
    ).toEqual({ subject: 'u1', name: 'Real Name' })
  })

  it('limits guests by address as well as by id, and all guests together per hour', async () => {
    const { key } = await guestSite()
    const seen: string[] = []
    const counting = {
      limit: async ({ key: k }: { key: string }) => {
        seen.push(k)
        return { success: !k.includes('"ip"') }
      },
    }
    const limited = await send(key, { guest: generateToken() }, { ip: '203.0.113.9', env: { INGEST_BURST: counting } })
    expect(limited.res.status).toBe(429)
    expect(limited.json.error).toBe('burst_limited')
    expect(seen.some((k) => k === JSON.stringify([key, 'ip', '203.0.113.9']))).toBe(true)

    // Fill the hour with guest reports from many different ids.
    const site = (await findIngestSite(env.DB, key))!
    const insertReporter = env.DB.prepare(
      'INSERT INTO reporters (account_id, site_id, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    const insertReport = env.DB.prepare(
      `INSERT INTO reports (public_id, account_id, site_id, reporter_id, kind, title, body, page_url, page_key,
      screenshot_mode, created_at, updated_at) SELECT ?, ?, ?, id, 'bug', 't', 'body', ?, ?, 'none', ?, ? FROM reporters
      WHERE site_id = ? AND subject = ?`,
    )
    const statements = []
    // One short of the ceiling, so the last place is still open.
    for (let i = 0; i < GUEST_SITE_LIMIT - 1; i++) {
      const subject = `guest:bulk${i}`
      statements.push(insertReporter.bind(site.account_id, site.id, subject, now(), now()))
      statements.push(
        insertReport.bind(`g${i}x${site.id}`, site.account_id, site.id, PAGE, PAGE, now(), now(), site.id, subject),
      )
    }
    await env.DB.batch(statements)
    // Five guests race for it. The database, not the handler's earlier look, decides:
    // exactly one gets in, however the requests interleave.
    const race = await Promise.all(Array.from({ length: 5 }, () => send(key, { guest: generateToken() })))
    expect(race.filter((r) => r.res.status === 201)).toHaveLength(1)
    for (const lost of race.filter((r) => r.res.status !== 201)) {
      expect(lost.res.status).toBe(429)
      expect(lost.json.error).toBe('site_limited')
      expect(lost.res.headers.get('retry-after')).toBe('3600')
    }
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM reports r JOIN reporters p ON p.id = r.reporter_id WHERE r.site_id = ? AND p.subject LIKE 'guest:%'",
      )
        .bind(site.id)
        .first<{ n: number }>())!.n,
    ).toBe(GUEST_SITE_LIMIT)
    // The ceiling is for guests only: a signed reporter on the same site is unaffected.
    const full = await send(key, { guest: generateToken() })
    expect(full.res.status).toBe(429)
  })
})

describe('a site that requires signed identity', () => {
  it('turns guests away from reporting and from reading pins', async () => {
    const me = await owner()
    const site = await newSite(me.cookie)
    expect((await findIngestSite(env.DB, site.key))!.identity_mode).toBe('signed')
    const refused = await send(site.key, { guest: generateToken() })
    expect(refused.res.status).toBe(401)
    expect(refused.json.error).toBe('identity_required')
    expect((await pins(site.key, `Guest ${generateToken()}`)).status).toBe(401)
    expect((await fileReport(site)).res.status).toBe(201)
    expect(site.html).toContain('identity: SERVER_SIGNED_IDENTITY_TOKEN')
  })

  it('switches a guest site to signed with a fresh secret shown once, and back', async () => {
    const { me, key } = await guestSite()
    const guest = generateToken()
    expect((await send(key, { guest })).res.status).toBe(201)
    const before = (await findIngestSite(env.DB, key))!.secret_cipher

    const res = await call(`/sites/${key}/identity`, { cookie: me.cookie, form: { mode: 'signed' } })
    expect(res.status).toBe(200)
    const secret = secretIn(await res.text())!
    const site = (await findIngestSite(env.DB, key))!
    expect(site.identity_mode).toBe('signed')
    expect(site.secret_cipher).not.toBe(before)
    expect(site.previous_secret_cipher).toBeNull()
    expect(await decryptSiteSecret(site.secret_cipher, env.SITE_KEK, key)).toBe(secret)
    expect((await send(key, { guest })).res.status).toBe(401)
    expect((await fileReport({ key, secret })).res.status).toBe(201)
    // Asking again changes nothing and shows nothing.
    const again = await call(`/sites/${key}/identity`, { cookie: me.cookie, form: { mode: 'signed' } })
    expect(again.status).toBe(303)
    expect((await findIngestSite(env.DB, key))!.secret_cipher).toBe(site.secret_cipher)
    expect(secretIn(await (await call(`/sites/${key}`, { cookie: me.cookie })).text())).toBeUndefined()

    expect((await call(`/sites/${key}/identity`, { cookie: me.cookie, form: { mode: 'guest' } })).status).toBe(303)
    expect((await send(key, { guest })).res.status).toBe(201)
    // The secret survives going back to guests, so signed pages keep working.
    expect((await fileReport({ key, secret })).res.status).toBe(201)
  })

  it('refuses a mangled choice rather than opening the site, and rotates only a signed site', async () => {
    const me = await owner()
    const site = await newSite(me.cookie)
    for (const mode of ['', 'Guest', 'open', 'signed ']) {
      const res = await call(`/sites/${site.key}/identity`, { cookie: me.cookie, form: { mode } })
      expect(res.status).toBe(400)
    }
    expect((await call(`/sites/${site.key}/identity`, { cookie: me.cookie, method: 'POST' })).status).toBe(400)
    expect((await findIngestSite(env.DB, site.key))!.identity_mode).toBe('signed')

    const open = await guestSite()
    const before = (await findIngestSite(env.DB, open.key))!
    const res = await call(`/sites/${open.key}/rotate`, { method: 'POST', cookie: open.me.cookie })
    expect(res.status).toBe(409)
    expect(secretIn(await res.text())).toBeUndefined()
    expect(await findIngestSite(env.DB, open.key)).toEqual(before)
  })

  it('renders a guest’s name and email as text', async () => {
    const { me, key } = await guestSite()
    const hostile = '"><script>alert(1)</script>'
    const { json } = await send(key, {
      guest: generateToken(),
      reporter: { name: hostile, email: 'a@b.example?bcc=x' },
    })
    for (const path of [`/reports/${json.id}`, `/sites/${key}/reports`]) {
      const html = await (await call(path, { cookie: me.cookie })).text()
      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;')
    }
    const href = /href="(mailto:[^"]*)"/.exec(
      await (await call(`/reports/${json.id}`, { cookie: me.cookie })).text(),
    )![1]!
    expect(href).not.toMatch(/[?&]/)
  })

  it('lets only the owning account change who can report', async () => {
    const { key } = await guestSite()
    const other = await owner()
    const res = await call(`/sites/${key}/identity`, { cookie: other.cookie, form: { mode: 'signed' } })
    expect(res.status).toBe(404)
    expect(secretIn(await res.text())).toBeUndefined()
    expect((await findIngestSite(env.DB, key))!.identity_mode).toBe('guest')
    expect((await call(`/sites/${key}/identity`, { form: { mode: 'signed' } })).status).toBe(303)
    expect(
      (await call(`/sites/${key}/identity`, { cookie: other.cookie, form: { mode: 'signed' }, origin: null })).status,
    ).toBe(403)
  })
})
