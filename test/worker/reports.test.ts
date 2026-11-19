import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/worker'
import { signViewToken, verifyViewToken } from '../../src/worker/auth/view-token'
import { INBOX_PAGE } from '../../src/worker/db/scoped'
import { ownerSubject } from '../../src/worker/notify'
import { jpeg } from '../core/fixtures/images'
import { BASE, call, fileReport, newSite, now, open, owner } from './helpers'

let logged: string[]
beforeEach(() => {
  logged = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.join(' '))
  })
})
afterEach(() => vi.restoreAllMocks())

const anchor = {
  v: 1,
  attrs: [{ depth: 0, name: 'data-bugzap-id', value: 'save' }],
  selector: '#save-button',
  tag: 'button',
  text: 'Save changes',
  rect: { x: 0, y: 0, w: 10, h: 10 },
  offset: { fx: 0.5, fy: 0.5 },
  page: { x: 5, y: 5 },
  viewport: { w: 1280, h: 800, dpr: 1, sx: 0, sy: 0 },
}
const report = (id: string) => env.DB.prepare('SELECT * FROM reports WHERE public_id = ?').bind(id).first()

async function setup() {
  const me = await owner()
  const site = await newSite(me.cookie)
  return { me, site }
}

describe('reports inbox', () => {
  it('lists new reports under the inbox tab, with counts per state', async () => {
    const { me, site } = await setup()
    const first = await fileReport(site, { pin: anchor }, { screenshot: jpeg() })
    await fileReport(site, { kind: 'idea', body: 'Add a dark theme please' }, { sub: 'other', name: 'Sam Ortiz' })
    expect(first.res.status).toBe(201)

    const html = await (await call(`/sites/${site.key}/reports`, { cookie: me.cookie })).text()
    expect(html).toContain(`/reports/${first.id}`)
    expect(html).toContain('The save button does nothing')
    expect(html).toContain('Add a dark theme please')
    expect(html).toContain('Dana Reyes')
    expect(html).toContain('Pinned · 1 image')
    expect(html).toContain('Whole page')
    expect(html).toMatch(/Inbox <span class="count">2<\/span>/)
    expect(html).toMatch(/Archived <span class="count">0<\/span>/)

    const archived = await (await call(`/sites/${site.key}/reports?state=archived`, { cookie: me.cookie })).text()
    expect(archived).not.toContain(first.id)
    expect(archived).toContain('Nothing here.')
    // An unknown state or page falls back instead of failing.
    expect((await call(`/sites/${site.key}/reports?state=nope&before=%27`, { cookie: me.cookie })).status).toBe(200)
    expect(await (await call('/sites', { cookie: me.cookie })).text()).toContain('2 new reports')
  })

  it('pages through more reports than fit on one screen', async () => {
    const { me, site } = await setup()
    const row = (await env.DB.prepare('SELECT id, account_id FROM sites WHERE public_key = ?')
      .bind(site.key)
      .first<{ id: number; account_id: number }>())!
    const reporter = (await env.DB.prepare(
      'INSERT INTO reporters (account_id, site_id, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    )
      .bind(row.account_id, row.id, 'bulk', now(), now())
      .first<{ id: number }>())!.id
    const insert = env.DB.prepare(
      `INSERT INTO reports (public_id, account_id, site_id, reporter_id, kind, title, body, page_url, page_key,
      screenshot_mode, created_at, updated_at) VALUES (?, ?, ?, ?, 'bug', ?, 'body', 'https://docs.example/', 'https://docs.example', 'none', ?, ?)`,
    )
    // Oldest first and 400 seconds apart: the schema's trigger allows ten per
    // reporter in the hour before each new row.
    await env.DB.batch(
      Array.from({ length: INBOX_PAGE + 3 }, (_, i) =>
        insert.bind(
          `bulk${String(i).padStart(4, '0')}${row.id}`,
          row.account_id,
          row.id,
          reporter,
          `Report ${i}`,
          now() - (INBOX_PAGE + 3 - i) * 400,
          now(),
        ),
      ),
    )
    const ids = (html: string) => [...html.matchAll(/href="\/reports\/([A-Za-z0-9]+)"/g)].map((m) => m[1]!)
    const one = await (await call(`/sites/${site.key}/reports`, { cookie: me.cookie })).text()
    expect(ids(one)).toHaveLength(INBOX_PAGE)
    expect(one).not.toContain('← Newest')
    const older = /href="([^"]*before=[A-Za-z0-9]+)"/.exec(one)![1]!.replaceAll('&amp;', '&')
    expect(older).toContain(`before=${ids(one).at(-1)}`)

    // A report that arrives, and one that is archived, between the two page
    // loads must not make page two repeat or skip a row.
    await fileReport(site)
    await env.DB.prepare("UPDATE reports SET state = 'archived' WHERE public_id = ?").bind(ids(one)[0]).run()
    const two = await (await call(older, { cookie: me.cookie })).text()
    expect(ids(two)).toHaveLength(3)
    expect(ids(two).filter((id) => ids(one).includes(id))).toEqual([])
    expect(two).toContain('← Newest')
    expect(two).not.toContain('Older →')
  })
})

describe('report detail', () => {
  it("shows the reporter's words escaped, the pin, the page, diagnostics, and the image", async () => {
    const { me, site } = await setup()
    const body = 'Broken <img src=x onerror=alert(1)> here.\nSecond line & more.'
    const { id } = await fileReport(site, { body, pin: anchor }, { screenshot: jpeg() })
    const res = await call(`/reports/${id}`, { cookie: me.cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain("img-src 'self'")
    const html = await res.text()
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('Second line &amp; more.')
    expect(html).toContain('mailto:dana%40host.example')
    expect(html).toContain('https://docs.example/editor')
    expect(html).toContain('#save-button')
    expect(html).toContain('Save changes')
    expect(html).toContain('&quot;build&quot;: &quot;v7&quot;')
    expect(html).toMatch(new RegExp(`<img src="/reports/${id}/images/[A-Za-z0-9]{22}"`))
  })

  it('treats every reporter-supplied field as text', async () => {
    const { me, site } = await setup()
    const hostile = '"><script>alert(1)</script>'
    const { id, res } = await fileReport(
      site,
      {
        page: { url: 'https://docs.example/editor', title: hostile },
        pin: { ...anchor, text: hostile, label: hostile, selector: `a[title='${hostile}']` },
        diagnostics: { context: { note: hostile } },
      },
      { name: hostile, email: 'victim@host.example?bcc=attacker%40evil.example&body=hi' },
    )
    expect(res.status).toBe(201)
    for (const path of [`/reports/${id}`, `/sites/${site.key}/reports`]) {
      const html = await (await call(path, { cookie: me.cookie })).text()
      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;')
    }
    const html = await (await call(`/reports/${id}`, { cookie: me.cookie })).text()
    // The address is one opaque recipient: no query can add a BCC or a body.
    const href = /href="(mailto:[^"]*)"/.exec(html)![1]!
    expect(href).not.toMatch(/[?&]/)
    expect(href).toBe(`mailto:${encodeURIComponent('victim@host.example?bcc=attacker%40evil.example&body=hi')}`)
  })

  it('saves triage and keeps the reporter’s words untouched', async () => {
    const { me, site } = await setup()
    const { id } = await fileReport(site)
    const form = {
      title: '  Save   is broken ',
      state: 'archived',
      status: 'done',
      priority: '1',
      note: ' Fixed in v8 ',
    }
    const res = await call(`/reports/${id}`, { cookie: me.cookie, form })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/reports/${id}?saved=1`)
    expect(await report(id)).toMatchObject({
      title: 'Save is broken',
      state: 'archived',
      status: 'done',
      priority: 1,
      owner_note: 'Fixed in v8',
      body: 'The save button does nothing.',
    })
    const html = await (await call(`/reports/${id}?saved=1`, { cookie: me.cookie })).text()
    expect(html).toContain('Saved.')
    expect(html).toContain('Fixed in v8')
    expect(await (await call(`/sites/${site.key}/reports?state=archived`, { cookie: me.cookie })).text()).toContain(id)

    await call(`/reports/${id}`, { cookie: me.cookie, form: { ...form, priority: '', note: '' } })
    expect(await report(id)).toMatchObject({ priority: null, owner_note: null })
  })

  it('refuses values outside the lists, and posts without an origin', async () => {
    const { me, site } = await setup()
    const { id } = await fileReport(site)
    const before = await report(id)
    const good = { title: 'Title', state: 'pending', status: 'new', priority: '', note: '' }
    const bad: Record<string, string>[] = [
      { state: 'deleted' },
      { status: 'wontfix' },
      { priority: '4' },
      { priority: '-1' },
      { title: '   ' },
      { title: 'x'.repeat(121) },
      { note: 'x'.repeat(2001) },
    ]
    for (const patch of bad)
      expect((await call(`/reports/${id}`, { cookie: me.cookie, form: { ...good, ...patch } })).status).toBe(400)
    expect((await call(`/reports/${id}`, { cookie: me.cookie, form: good, origin: null })).status).toBe(403)
    expect(await report(id)).toEqual(before)
  })
})

describe('image proxy', () => {
  it('serves a stored image only through the session, locked down', async () => {
    const { me, site } = await setup()
    const { id } = await fileReport(site, {}, { screenshot: jpeg() })
    const row = (await env.DB.prepare(
      'SELECT a.public_id, a.object_key, a.bytes FROM attachments a JOIN reports r ON r.id = a.report_id WHERE r.public_id = ?',
    )
      .bind(id)
      .first<{ public_id: string; object_key: string; bytes: number }>())!
    const path = `/reports/${id}/images/${row.public_id}`

    const res = await call(path, { cookie: me.cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const served = new Uint8Array(await res.arrayBuffer())
    const stored = new Uint8Array(await (await env.SHOTS.get(row.object_key))!.arrayBuffer())
    expect(served).toEqual(stored)
    expect(served.length).toBe(row.bytes)

    const signedOut = await call(path)
    expect(signedOut.status).toBe(303)
    expect(signedOut.headers.get('location')).toBe('/login')
    expect((await call(`/reports/${id}/images/${'0'.repeat(22)}`, { cookie: me.cookie })).status).toBe(404)
    // An image row whose object is gone is a 404, not an error page.
    await env.SHOTS.delete(row.object_key)
    expect((await call(path, { cookie: me.cookie })).status).toBe(404)
  })
})

describe('cross-account isolation for reports', () => {
  it("answers 404 for another account's reports, images, and inbox, and changes nothing", async () => {
    const { site } = await setup()
    const { id } = await fileReport(site, {}, { screenshot: jpeg() })
    const image = (await env.DB.prepare(
      'SELECT a.public_id FROM attachments a JOIN reports r ON r.id = a.report_id WHERE r.public_id = ?',
    )
      .bind(id)
      .first<{ public_id: string }>())!.public_id
    const before = await report(id)
    const other = await owner()

    const unknown = await (await call(`/reports/${'0'.repeat(22)}`, { cookie: other.cookie })).text()
    const form = { title: 'Mine now', state: 'spam', status: 'done', priority: '0', note: 'x' }
    for (const attempt of [
      call(`/reports/${id}`, { cookie: other.cookie }),
      call(`/reports/${id}`, { cookie: other.cookie, form }),
      call(`/reports/${id}/images/${image}`, { cookie: other.cookie }),
    ]) {
      const res = await attempt
      expect(res.status).toBe(404)
      const html = await res.text()
      expect(html).toBe(unknown)
      expect(html).not.toContain('save button')
    }
    expect((await call(`/sites/${site.key}/reports`, { cookie: other.cookie })).status).toBe(404)
    expect(await report(id)).toEqual(before)
    // A site of their own never lists someone else's report.
    const theirs = await newSite(other.cookie)
    expect(await (await call(`/sites/${theirs.key}/reports`, { cookie: other.cookie })).text()).not.toContain(id)
  })
})

describe('owner notification', () => {
  it('mails each owner a link after the report commits, keeping the reporter’s words out of the log', async () => {
    const { me, site } = await setup()
    const member = await owner()
    await env.DB.prepare("INSERT INTO memberships (account_id, user_id, role) VALUES (?, ?, 'member')")
      .bind(me.accountId, member.userId)
      .run()
    const { res, id } = await fileReport(site, { body: 'Checkout total is wrong by one cent.' })
    expect(res.status).toBe(201)
    const mail = logged.filter((line) => line.includes('[mail]'))
    expect(mail).toHaveLength(1)
    expect(mail[0]).toContain(`To: ${me.email}`)
    expect(mail[0]).toContain(`http://bugzap.test/reports/${id}`)
    expect(mail[0]).not.toContain('Checkout total')
    expect(mail[0]).not.toContain('Dana')
    expect(mail[0]).not.toContain('dana@host.example')
  })

  it('never turns a saved report into an error', async () => {
    const { site } = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('log sink is down')
    })
    const { res, id } = await fileReport(site)
    expect(res.status).toBe(201)
    expect(await report(id)).toBeTruthy()
  })

  it('writes a subject a mail client will not cut', () => {
    expect(ownerSubject('bug', 'Save is broken')).toBe('Bug: Save is broken')
    const long = ownerSubject('question', 'x'.repeat(200))
    expect(long).toHaveLength(78)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('open on page', () => {
  const PAGE = 'https://docs.example/editor'
  function view(
    key: string,
    token: string | null,
    options: { origin?: string; page?: string; scheme?: string; method?: string } = {},
  ) {
    const headers: Record<string, string> = { Origin: options.origin ?? 'https://docs.example' }
    if (options.method === 'OPTIONS') {
      headers['Access-Control-Request-Method'] = 'GET'
      headers['Access-Control-Request-Headers'] = 'authorization'
    } else if (token !== null) headers.Authorization = `${options.scheme ?? 'View'} ${token}`
    return app.fetch(
      new Request(`${BASE}/v1/pins/view?site=${key}&page=${encodeURIComponent(options.page ?? PAGE)}`, {
        method: options.method ?? 'GET',
        headers,
      }),
      { ...env, PINS_READ: open },
      createExecutionContext(),
    )
  }
  const tokenIn = (location: string) => /#bugzap-view=(bzv1\.[\w.-]+)$/.exec(location)?.[1]

  it('signs a token that names one report and expires', async () => {
    const id = 'ABCDEFGHIJKLMNOPQRSTUV'
    const token = await signViewToken(env.SITE_KEK, id, now() + 900)
    expect(await verifyViewToken(env.SITE_KEK, token, now())).toBe(id)
    expect(await verifyViewToken(env.SITE_KEK, token, now() + 901)).toBeNull()
    const [v, , exp, sig] = token.split('.')
    const forged = [
      `${v}.BBCDEFGHIJKLMNOPQRSTUV.${exp}.${sig}`,
      `${v}.${id}.${Number(exp) + 1}.${sig}`,
      `${v}.${id}.${exp}.${sig!.slice(0, -2)}AA`,
      `bzv2.${id}.${exp}.${sig}`,
      `${token}.extra`,
      `${v}.${id}.${exp}`,
      'x'.repeat(500),
      '',
      null,
      await signViewToken(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replace(/=+$/, ''), id, now() + 900),
    ]
    for (const bad of forged) expect(await verifyViewToken(env.SITE_KEK, bad, now())).toBeNull()
    // Correctly signed, but for longer than any view link is allowed to last.
    expect(await verifyViewToken(env.SITE_KEK, await signViewToken(env.SITE_KEK, id, now() + 86400), now())).toBeNull()
  })

  it('redirects a pinned report to its page with a token the widget route accepts', async () => {
    const { me, site } = await setup()
    const { id } = await fileReport(site, { pin: anchor })
    const res = await call(`/reports/${id}/open`, { cookie: me.cookie })
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    expect(location.startsWith(`${PAGE}#bugzap-view=bzv1.${id}.`)).toBe(true)
    const token = tokenIn(location)!

    const ok = await view(site.key, token)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://docs.example')
    expect(ok.headers.get('cache-control')).toBe('no-store')
    const body = await ok.json<{ ok: boolean; pin: { id: string; body: string; anchor: { selector: string } } }>()
    expect(body.pin).toMatchObject({ id, body: 'The save button does nothing.', anchor: { selector: '#save-button' } })
    expect((await view(site.key, null, { method: 'OPTIONS' })).status).toBe(204)

    // Archived is still viewable by its owner; spam is never drawn on a host page.
    await env.DB.prepare("UPDATE reports SET state = 'archived' WHERE public_id = ?").bind(id).run()
    expect((await view(site.key, token)).status).toBe(200)
    await env.DB.prepare("UPDATE reports SET state = 'spam' WHERE public_id = ?").bind(id).run()
    expect((await view(site.key, token)).status).toBe(404)
  })

  it('shows nothing on another page, site, or origin, or without a valid token', async () => {
    const { me, site } = await setup()
    const second = await newSite(me.cookie, { origins: 'https://docs.example\nhttps://other.example' })
    const { id } = await fileReport(site, { pin: anchor })
    const token = tokenIn((await call(`/reports/${id}/open`, { cookie: me.cookie })).headers.get('location')!)!

    expect((await view(site.key, token, { page: 'https://docs.example/elsewhere' })).status).toBe(404)
    expect((await view(second.key, token)).status).toBe(404)
    expect(
      (await view(site.key, token, { origin: 'https://other.example', page: 'https://other.example/editor' })).status,
    ).toBe(403)
    expect((await view(site.key, token, { page: 'https://other.example/editor' })).status).toBe(400)
    for (const bad of [null, 'garbage', `${token}x`]) expect((await view(site.key, bad)).status).toBe(401)
    expect((await view(site.key, token, { scheme: 'Bearer' })).status).toBe(401)
    const expired = await signViewToken(env.SITE_KEK, id, now() - 1)
    expect((await view(site.key, expired)).status).toBe(401)
    // A view token is not an identity: the reporter route refuses it.
    const asReporter = await app.fetch(
      new Request(`${BASE}/v1/pins?site=${site.key}&page=${encodeURIComponent(PAGE)}`, {
        headers: { Origin: 'https://docs.example', Authorization: `Bearer ${token}` },
      }),
      { ...env, PINS_READ: open },
      createExecutionContext(),
    )
    expect(asReporter.status).toBe(401)
  })

  it('opens a whole-page report without a token, and refuses an origin the site dropped', async () => {
    const { me, site } = await setup()
    const { id } = await fileReport(site)
    const plain = await call(`/reports/${id}/open`, { cookie: me.cookie })
    expect(plain.status).toBe(302)
    expect(plain.headers.get('location')).toBe(PAGE)

    await call(`/sites/${site.key}/origins/remove`, { cookie: me.cookie, form: { origin: 'https://docs.example' } })
    const dropped = await call(`/reports/${id}/open`, { cookie: me.cookie })
    expect(dropped.status).toBe(409)
    expect(dropped.headers.get('location')).toBeNull()

    const other = await owner()
    expect((await call(`/reports/${id}/open`, { cookie: other.cookie })).status).toBe(404)
    expect((await call(`/reports/${id}/open`)).status).toBe(303)
  })
})
