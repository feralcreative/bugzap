import { createExecutionContext, SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId, generatePublicKey, generateSecretKey } from '../../src/core/ids'
import { signIdentity } from '../../src/core/identity'
import { REPORT_JSON_MAX } from '../../src/core/payload'
import { KINDS, STATES, STATUSES, SUBMIT_LIMIT } from '../../src/core/policy'
import app from '../../src/worker'
import { decryptSiteSecret, encryptSiteSecret } from '../../src/worker/crypto'
import { findIngestSite, hourlyCount, saveReport } from '../../src/worker/db/scoped'
import { REPORT_REQUEST_MAX } from '../../src/worker/ingest/body'
import { contains, jpeg, png, SECRET } from '../core/fixtures/images'

const ORIGIN = 'https://host.example'
const now = () => Math.floor(Date.now() / 1000)
let account: number
let site: number
let publicKey: string
let secret: string
let token: string

const claims = (sub = 'reporter') => ({
  sub,
  email: 'reporter@example.com',
  name: 'A reporter',
  iat: now(),
  exp: now() + 86400,
})
const anchor = () => ({
  v: 1,
  attrs: [{ depth: 0, name: 'data-bugzap-id', value: 'save' }],
  selector: '#save',
  tag: 'button',
  rect: { x: 0, y: 0, w: 10, h: 10 },
  offset: { fx: 0.5, fy: 0.5 },
  page: { x: 5, y: 5 },
  viewport: { w: 1280, h: 800, dpr: 1, sx: 0, sy: 0 },
})
const payload = (patch: Record<string, unknown> = {}) => ({
  v: 1,
  site: publicKey,
  identity: token,
  kind: 'bug',
  body: '  The save button does nothing.  ',
  page: { url: `${ORIGIN}/editor/?reset=private-reset#private-fragment`, title: 'Editor' },
  pin: anchor(),
  screenshot: { mode: 'none' },
  diagnostics: {
    app: { referrer: `${ORIGIN}/?reset=private-reset` },
    context: { token: 'private-token', build: 'v1' },
    net: [{ path: '/api?token=private-query', status: 500 }],
  },
  ...patch,
})
const imageFile = (bytes: Uint8Array, name = '../../evil.html') =>
  new File([new Uint8Array(bytes)], name, { type: 'text/html' })
function form(p: unknown = payload()) {
  const out = new FormData()
  out.set('payload', JSON.stringify(p))
  return out
}
function request(body: FormData | string | ReadableStream = form(), headers: Record<string, string> = {}, query = '') {
  return new Request(`http://bugzap.test/v1/reports${query}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, ...headers },
    body,
  })
}
function submit(
  body: FormData | string | ReadableStream = form(),
  headers: Record<string, string> = {},
  overrides: Partial<Env> = {},
) {
  return app.fetch(
    request(body, headers),
    { ...env, INGEST_BURST: { limit: async () => ({ success: true }) }, ...overrides },
    createExecutionContext(),
  )
}
async function refusal(response: Response, status: number, error: string) {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ ok: false, error })
  expect(response.headers.get('cache-control')).toBe('no-store')
}
async function rows(table: string) {
  // Only fixed table names in this test file; production SQL never interpolates identifiers.
  return (await env.DB.prepare(`SELECT * FROM ${table} WHERE account_id = ?`).bind(account).all()).results
}
async function objects() {
  return (await env.SHOTS.list({ prefix: `${account}/${site}/` })).objects
}

beforeEach(async () => {
  publicKey = generatePublicKey()
  secret = generateSecretKey()
  account = (await env.DB.prepare('INSERT INTO accounts (public_id, name) VALUES (?, ?) RETURNING id')
    .bind(generateId(), 'Test account')
    .first<{ id: number }>())!.id
  site = (await env.DB.prepare(
    'INSERT INTO sites (account_id, public_key, name, secret_cipher) VALUES (?, ?, ?, ?) RETURNING id',
  )
    .bind(account, publicKey, 'Test site', await encryptSiteSecret(secret, env.SITE_KEK, publicKey))
    .first<{ id: number }>())!.id
  await env.DB.prepare('INSERT INTO site_origins (account_id, site_id, origin) VALUES (?, ?, ?)')
    .bind(account, site, ORIGIN)
    .run()
  token = await signIdentity(claims(), secret)
})
afterEach(() => vi.restoreAllMocks())

describe('report ingest', () => {
  it('atomically stores a private report, pin, redacted diagnostics and cleaned private images', async () => {
    const body = form(payload({ screenshot: { mode: 'auto' } }))
    body.set('screenshot', imageFile(jpeg()))
    body.append('attachments', imageFile(png()))
    body.append('attachments', imageFile(jpeg()))
    const res = await SELF.fetch(request(body))
    expect(res.status).toBe(201)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const result = await res.json<{ ok: boolean; id: string }>()
    expect(result.id).toMatch(/^[A-Za-z0-9]{22}$/)
    const reports = await rows('reports')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      public_id: result.id,
      site_id: site,
      state: 'pending',
      status: 'new',
      body: 'The save button does nothing.',
      page_url: `${ORIGIN}/editor`,
      page_key: `${ORIGIN}/editor`,
    })
    expect(await rows('reporters')).toHaveLength(1)
    expect(await rows('pins')).toHaveLength(1)
    const diagnostics = JSON.stringify(await rows('diagnostics'))
    for (const value of ['private-reset', 'private-token', 'private-query', token])
      expect(diagnostics).not.toContain(value)
    const attachments = await rows('attachments')
    expect(attachments).toHaveLength(3)
    for (const file of attachments) {
      const key = String(file.object_key)
      expect(key).toMatch(new RegExp(`^${account}/${site}/${result.id}/[A-Za-z0-9]{22}\\.(jpeg|png)$`))
      expect(key).not.toContain('evil')
      const object = await env.SHOTS.get(key)
      expect(object).not.toBeNull()
      expect(object!.httpMetadata?.contentType).toBe(file.mime)
      const bytes = new Uint8Array(await object!.arrayBuffer())
      expect(contains(bytes, SECRET)).toBe(false)
      expect(bytes.length).toBe(file.bytes)
      expect((await SELF.fetch(`http://bugzap.test/${key}`)).status).toBe(404)
    }
  })

  it.each(KINDS)('accepts a %s without a pin or screenshot and updates the same reporter', async (kind) => {
    for (let n = 0; n < 2; n++) {
      const res = await submit(form(payload({ kind, pin: null })))
      expect(res.status).toBe(201)
      await res.arrayBuffer()
    }
    expect(await rows('reports')).toHaveLength(2)
    expect(await rows('reporters')).toHaveLength(1)
    expect(await rows('pins')).toHaveLength(0)
    expect(await objects()).toHaveLength(0)
  })

  it('does not store diagnostics garbage or unsigned identity fields', async () => {
    const res = await submit(
      form(payload({ diagnostics: 'garbage', reporter: { email: 'forged@example.com' }, account_id: 999 })),
    )
    expect(res.status).toBe(201)
    await res.arrayBuffer()
    expect((await rows('reporters'))[0]).toMatchObject({ email: 'reporter@example.com', name: 'A reporter' })
    expect((await rows('diagnostics'))[0]?.data_json).toBe('{}')
  })

  it('keeps valid short Unicode bodies when SQLite counts fewer characters than JavaScript', async () => {
    const res = await submit(form(payload({ body: '🐛a' })))
    expect(res.status).toBe(201)
    await res.arrayBuffer()
    expect((await rows('reports'))[0]?.body).toBe('🐛a')
  })

  it.each([
    ['version', { v: 2 }],
    ['kind', { kind: 'ticket' }],
    ['body', { body: ' ' }],
    ['pin', { pin: {} }],
    ['mode', { screenshot: { mode: 'magic' } }],
  ])('refuses invalid %s', async (_label, patch) => {
    await refusal(await submit(form(payload(patch))), 400, 'invalid_payload')
    expect(await rows('reports')).toHaveLength(0)
    expect(await rows('reporters')).toHaveLength(0)
  })

  it.each([
    `${ORIGIN}.evil/editor`,
    `${ORIGIN}/../`,
    'https://other.example/',
    'https://%broken',
    'http://host.example/',
  ])('validates page URL %s', async (url) => {
    const res = await submit(form(payload({ page: { url } })))
    if (url === `${ORIGIN}/../`) {
      expect(res.status).toBe(201)
      await res.arrayBuffer()
    } else await refusal(res, 400, 'invalid_page')
  })

  it('refuses unknown fields, duplicate payloads, missing screenshot and excess images', async () => {
    for (const [body, code] of [
      [form(payload({ screenshot: { mode: 'auto' } })), 'screenshot_mismatch'],
      [
        (() => {
          const f = form()
          f.set('screenshot', imageFile(jpeg()))
          return f
        })(),
        'screenshot_mismatch',
      ],
      [
        (() => {
          const f = form()
          f.append('attachments', imageFile(jpeg()))
          f.append('attachments', imageFile(jpeg()))
          f.append('attachments', imageFile(jpeg()))
          return f
        })(),
        'too_many_images',
      ],
      [
        (() => {
          const f = form()
          f.set('object_key', 'someone/elses/key')
          return f
        })(),
        'invalid_parts',
      ],
      [
        (() => {
          const f = form()
          f.append('payload', '{}')
          return f
        })(),
        'invalid_payload',
      ],
    ] as const)
      await refusal(await submit(body), 400, code)
    expect(await objects()).toHaveLength(0)
  })

  it('rejects invalid multipart, JSON, JSON file parts, and non-multipart requests', async () => {
    await refusal(await submit('{}', { 'Content-Type': 'application/json' }), 415, 'unsupported_media_type')
    await refusal(
      await submit('broken', { 'Content-Type': 'multipart/form-data; boundary=x' }),
      400,
      'invalid_multipart',
    )
    for (const value of ['{', 'null', '[]']) {
      const body = new FormData()
      body.set('payload', value)
      await refusal(await submit(body), 400, 'invalid_payload')
    }
    const body = new FormData()
    body.set('payload', new File(['{}'], 'payload.json'))
    await refusal(await submit(body), 400, 'invalid_payload')
    await refusal(await submit(new FormData()), 400, 'invalid_payload')
  })

  it('caps declared and streamed request sizes and JSON bytes, including Unicode', async () => {
    await refusal(await submit(form(), { 'Content-Length': String(REPORT_REQUEST_MAX + 1) }), 413, 'request_too_large')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(REPORT_REQUEST_MAX + 1))
        controller.close()
      },
    })
    await refusal(await submit(stream, { 'Content-Type': 'multipart/form-data; boundary=x' }), 413, 'request_too_large')
    const body = form(payload({ diagnostics: '☃'.repeat(REPORT_JSON_MAX / 2) }))
    await refusal(await submit(body), 413, 'payload_too_large')
  })

  it('rejects text pretending to be an image, empty, corrupt, huge and over-pixel images before writing', async () => {
    const cases: [File | string, number, string][] = [
      ['not a file', 400, 'invalid_image'],
      [imageFile(new Uint8Array()), 415, 'invalid_image'],
      [imageFile(new TextEncoder().encode('<script>bad</script>')), 415, 'invalid_image'],
      [imageFile(jpeg().slice(0, -100)), 415, 'invalid_image'],
      [imageFile(png({ width: 65000, height: 65000 })), 415, 'invalid_image'],
      [imageFile(new Uint8Array(2 * 1024 * 1024 + 1)), 413, 'image_too_large'],
    ]
    for (const [file, status, code] of cases) {
      const body = form(payload({ screenshot: { mode: 'upload' } }))
      body.set('screenshot', file)
      await refusal(await submit(body), status, code)
    }
    expect(await objects()).toHaveLength(0)
    expect(await rows('reports')).toHaveLength(0)
  })
})

describe('site, identity and origin gates', () => {
  it('requires a public key, a known site, an allowed origin and an enabled site', async () => {
    await refusal(await submit(form(payload({ site: secret }))), 400, 'invalid_site_key')
    await refusal(await submit(form(payload({ site: generatePublicKey() }))), 404, 'site_not_found')
    for (const Origin of ['', 'null', `${ORIGIN}.evil`, `${ORIGIN}/path`, 'http://host.example'])
      await refusal(await submit(form(), { Origin }), 403, 'origin_forbidden')
    await env.DB.prepare('UPDATE sites SET enabled = 0 WHERE id = ?').bind(site).run()
    await refusal(await submit(), 403, 'site_disabled')
  })

  it('checks the origin before attempting an invalid identity and returns CORS on allowed-origin errors', async () => {
    const body = () => form(payload({ identity: 'bad' }))
    const denied = await submit(body(), { Origin: 'https://evil.example' })
    await refusal(denied, 403, 'origin_forbidden')
    expect(denied.headers.has('access-control-allow-origin')).toBe(false)
    const allowed = await submit(body())
    await refusal(allowed, 401, 'invalid_identity')
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(allowed.headers.has('access-control-allow-credentials')).toBe(false)
  })

  it('rejects unsigned, tampered, expired, missing and other-site identities', async () => {
    const bad = [
      undefined,
      '',
      'bad',
      token.slice(0, -5) + 'AAAAA',
      await signIdentity({ ...claims(), exp: now() - 120, iat: now() - 500 }, secret),
      await signIdentity(claims(), generateSecretKey()),
    ]
    for (const identity of bad) await refusal(await submit(form(payload({ identity }))), 401, 'invalid_identity')
    expect(await rows('reporters')).toHaveLength(0)
  })

  it('allows the previous secret only within its rotation grace period', async () => {
    const previous = generateSecretKey()
    await env.DB.prepare('UPDATE sites SET previous_secret_cipher = ?, previous_secret_expires_at = ? WHERE id = ?')
      .bind(await encryptSiteSecret(previous, env.SITE_KEK, publicKey), now() + 86400, site)
      .run()
    const previousToken = await signIdentity(claims(), previous)
    const res = await submit(form(payload({ identity: previousToken })))
    expect(res.status).toBe(201)
    await res.arrayBuffer()
    await env.DB.prepare('UPDATE sites SET previous_secret_expires_at = ? WHERE id = ?')
      .bind(now() - 1, site)
      .run()
    await refusal(await submit(form(payload({ identity: previousToken }))), 401, 'invalid_identity')
    // A malformed expired envelope must never stop the current secret from working.
    await env.DB.prepare('UPDATE sites SET previous_secret_cipher = ? WHERE id = ?').bind('broken', site).run()
    const current = await submit()
    expect(current.status).toBe(201)
    await current.arrayBuffer()
  })

  it('answers only allowlisted preflights and refuses mismatched URL/body site keys', async () => {
    const headers = {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    }
    const preflight = () =>
      new Request(`http://bugzap.test/v1/reports?site=${publicKey}`, { method: 'OPTIONS', headers })
    const ok = await SELF.fetch(preflight())
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    headers.Origin = 'https://evil.example'
    await refusal(await SELF.fetch(preflight()), 403, 'origin_forbidden')
    headers.Origin = ORIGIN
    headers['Access-Control-Request-Headers'] = 'authorization'
    await refusal(await SELF.fetch(preflight()), 403, 'origin_forbidden')
    const wrong = request(form(), {}, `?site=${generatePublicKey()}`)
    await refusal(await app.fetch(wrong, env, createExecutionContext()), 400, 'invalid_site_key')
  })

  it('fails closed when the encryption key is wrong without exposing its error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await submit(form(), {}, { SITE_KEK: 'invalid-key' })
    await refusal(res, 503, 'service_unavailable')
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
    expect(await rows('reports')).toHaveLength(0)
  })
})

describe('limits, transactions and tenant integrity', () => {
  it('returns retry advice for burst limits before payload/image work', async () => {
    const limit = vi.fn(async () => ({ success: false }))
    const res = await submit(form(payload({ kind: 'invalid' })), {}, { INGEST_BURST: { limit } })
    await refusal(res, 429, 'burst_limited')
    expect(res.headers.get('retry-after')).toBe('10')
    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After')
    expect(limit).toHaveBeenCalledWith({ key: JSON.stringify([publicKey, 'reporter']) })
    expect(await rows('reports')).toHaveLength(0)
  })

  it('enforces the real Workers burst binding', async () => {
    const statuses = []
    for (let n = 0; n < 6; n++) {
      const res = await SELF.fetch(request(form(payload({ kind: 'invalid' }))))
      statuses.push(res.status)
      await res.arrayBuffer()
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429])
  })

  it('rejects the eleventh report and resets the rolling hour without changing another subject', async () => {
    for (let n = 0; n < SUBMIT_LIMIT; n++) {
      const res = await submit()
      expect(res.status).toBe(201)
      await res.arrayBuffer()
    }
    const denied = await submit()
    await refusal(denied, 429, 'hourly_limited')
    expect(denied.headers.get('retry-after')).toBe('3600')
    const other = await submit(form(payload({ identity: await signIdentity(claims('other'), secret) })))
    expect(other.status).toBe(201)
    await other.arrayBuffer()
    await env.DB.prepare('UPDATE reports SET created_at = ? WHERE account_id = ?')
      .bind(now() - 3601, account)
      .run()
    const fresh = await submit()
    expect(fresh.status).toBe(201)
    await fresh.arrayBuffer()
  })

  it('closes the concurrent hourly race in the database, including reporter-upsert rollback', async () => {
    const resolvedSite = (await findIngestSite(env.DB, publicKey))!
    const parsed = (await import('../../src/core/payload')).parseReportPayload(payload())
    if (!parsed.ok) throw new Error(parsed.error)
    const save = (n: number) =>
      saveReport(env.DB, resolvedSite, {
        publicId: generateId(),
        claims: { ...claims(), name: `Attempt ${n}` },
        payload: parsed.value,
        pageKey: `${ORIGIN}/editor`,
        diagnostics: {},
        images: [],
        now: now(),
      })
    const attempts = await Promise.allSettled(Array.from({ length: 15 }, (_, n) => save(n)))
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(SUBMIT_LIMIT)
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(5)
    expect(await hourlyCount(env.DB, resolvedSite, 'reporter', now())).toBe(SUBMIT_LIMIT)
    const prior = (await rows('reporters'))[0]?.name
    await expect(save(99)).rejects.toThrow('report_hourly_limit')
    expect((await rows('reporters'))[0]?.name).toBe(prior)
    expect(await rows('diagnostics')).toHaveLength(SUBMIT_LIMIT)
  })

  it('rolls back all D1 rows and removes R2 files when a child write fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await env.DB.exec(
      "CREATE TRIGGER fail_diagnostics BEFORE INSERT ON diagnostics BEGIN SELECT RAISE(ABORT, 'test_storage_failure'); END;",
    )
    try {
      const body = form(payload({ screenshot: { mode: 'upload' } }))
      body.set('screenshot', imageFile(jpeg()))
      await refusal(await submit(body), 503, 'storage_unavailable')
      for (const table of ['reports', 'reporters', 'pins', 'attachments', 'diagnostics'])
        expect(await rows(table)).toHaveLength(0)
      expect(await objects()).toHaveLength(0)
      expect(JSON.stringify(log.mock.calls)).not.toContain(token)
    } finally {
      await env.DB.exec('DROP TRIGGER fail_diagnostics')
    }
  })

  it('cleans up all attempted uploads, including a put that failed after writing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const original = env.SHOTS.put.bind(env.SHOTS)
    let writes = 0
    const put = vi.spyOn(env.SHOTS, 'put').mockImplementation(async (...args: Parameters<R2Bucket['put']>) => {
      const value = await original(...args)
      if (++writes === 2) throw new Error('test upload failure')
      return value
    })
    const body = form(payload({ screenshot: { mode: 'auto' } }))
    body.set('screenshot', imageFile(jpeg()))
    body.append('attachments', imageFile(png()))
    await refusal(await submit(body), 503, 'storage_unavailable')
    expect(put).toHaveBeenCalledTimes(2)
    expect(await objects()).toHaveLength(0)
    expect(await rows('reports')).toHaveLength(0)
  })

  it('maps a database hourly refusal after the early check to 429 and removes the uploaded image', async () => {
    await env.DB.exec(
      "CREATE TRIGGER race_hourly BEFORE INSERT ON reports BEGIN SELECT RAISE(ABORT, 'report_hourly_limit'); END;",
    )
    try {
      const body = form(payload({ screenshot: { mode: 'auto' } }))
      body.set('screenshot', imageFile(png()))
      await refusal(await submit(body), 429, 'hourly_limited')
      expect(await objects()).toHaveLength(0)
      expect(await rows('reporters')).toHaveLength(0)
    } finally {
      await env.DB.exec('DROP TRIGGER race_hourly')
    }
  })

  it('preserves the report and its image when the database commits but its response is lost', async () => {
    const original = env.DB.batch.bind(env.DB)
    vi.spyOn(env.DB, 'batch').mockImplementation(async (statements) => {
      await original(statements)
      throw new Error('test lost response')
    })
    const body = form(payload({ screenshot: { mode: 'auto' } }))
    body.set('screenshot', imageFile(png()))
    const res = await submit(body)
    expect(res.status).toBe(201)
    await res.arrayBuffer()
    expect(await rows('reports')).toHaveLength(1)
    expect(await rows('attachments')).toHaveLength(1)
    expect(await objects()).toHaveLength(1)
  })

  it('enforces tenant foreign keys and schema enums', async () => {
    const res = await submit()
    expect(res.status).toBe(201)
    await res.arrayBuffer()
    const report = (await rows('reports'))[0]!
    const otherAccount = (await env.DB.prepare('INSERT INTO accounts (public_id, name) VALUES (?, ?) RETURNING id')
      .bind(generateId(), 'Other account')
      .first<{ id: number }>())!.id
    await expect(
      env.DB.prepare('INSERT INTO site_origins (account_id, site_id, origin) VALUES (?, ?, ?)')
        .bind(otherAccount, site, 'https://other.example')
        .run(),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare('INSERT INTO diagnostics (account_id, site_id, report_id, data_json) VALUES (?, ?, ?, ?)')
        .bind(otherAccount, site, report.id, '{}')
        .run(),
    ).rejects.toThrow()
    for (const [column, values] of [
      ['kind', KINDS],
      ['state', STATES],
      ['status', STATUSES],
    ] as const) {
      for (const value of values)
        await env.DB.prepare(`UPDATE reports SET ${column} = ? WHERE id = ?`).bind(value, report.id).run()
      await expect(
        env.DB.prepare(`UPDATE reports SET ${column} = 'invalid' WHERE id = ?`).bind(report.id).run(),
      ).rejects.toThrow()
    }
    // Identical host subjects on different sites remain different reporters.
    const otherSite = (await env.DB.prepare(
      'INSERT INTO sites (account_id, public_key, name, secret_cipher) VALUES (?, ?, ?, ?) RETURNING id',
    )
      .bind(otherAccount, generatePublicKey(), 'Other site', 'unused')
      .first<{ id: number }>())!.id
    await expect(
      env.DB.prepare('UPDATE reports SET site_id = ?, account_id = ? WHERE id = ?')
        .bind(otherSite, otherAccount, report.id)
        .run(),
    ).rejects.toThrow()
  })
})

describe('site secret encryption', () => {
  it('uses random authenticated envelopes bound to the site and the encryption key', async () => {
    const first = await encryptSiteSecret(secret, env.SITE_KEK, publicKey)
    expect(await encryptSiteSecret(secret, env.SITE_KEK, publicKey)).not.toBe(first)
    expect(first).not.toContain(secret)
    expect(await decryptSiteSecret(first, env.SITE_KEK, publicKey)).toBe(secret)
    await expect(decryptSiteSecret(first, env.SITE_KEK, generatePublicKey())).rejects.toThrow()
    await expect(decryptSiteSecret(first + 'x', env.SITE_KEK, publicKey)).rejects.toThrow()
    await expect(decryptSiteSecret('broken', env.SITE_KEK, publicKey)).rejects.toThrow()
  })
})
