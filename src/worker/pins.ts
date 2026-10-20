import { Hono } from 'hono'
import { isPublicKey } from '../core/ids'
import { IDENTITY_TOKEN_MAX } from '../core/identity'
import { normalizeOrigin, urlKey } from '../core/url'
import { allowsOrigin, findIngestSite, reporterPins } from './db/scoped'
import { siteIdentity } from './identity'
import { IngestError } from './ingest/body'

const pins = new Hono<{ Bindings: Env }>()
pins.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Vary', 'Origin')
  await next()
})

pins.on(['GET', 'OPTIONS'], '/', async (c) => {
  const key = c.req.query('site')
  if (!isPublicKey(key)) throw new IngestError(400, 'invalid_site_key', 'A public site key is required.')
  const site = await findIngestSite(c.env.DB, key)
  if (!site) throw new IngestError(404, 'site_not_found', 'That site was not found.')
  const origin = c.req.header('Origin') ?? ''
  if (!origin || normalizeOrigin(origin) !== origin || !(await allowsOrigin(c.env.DB, site, origin)))
    throw new IngestError(403, 'origin_forbidden', 'This origin cannot read pins for that site.')
  c.header('Access-Control-Allow-Origin', origin)
  c.header('Access-Control-Expose-Headers', 'Retry-After')
  if (!site.enabled) throw new IngestError(403, 'site_disabled', 'This site is disabled.')
  if (c.req.method === 'OPTIONS') {
    const headers = (c.req.header('Access-Control-Request-Headers') ?? '')
      .toLowerCase()
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
    if (c.req.header('Access-Control-Request-Method') !== 'GET' || headers.some((h) => h !== 'authorization'))
      throw new IngestError(403, 'origin_forbidden', 'This cross-origin request is not allowed.')
    c.header('Access-Control-Allow-Methods', 'GET')
    c.header('Access-Control-Allow-Headers', 'Authorization')
    return c.body(null, 204)
  }
  if (c.req.method !== 'GET') return c.notFound()
  const authorization = c.req.header('Authorization') ?? ''
  const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1]
  if (!token || token.length > IDENTITY_TOKEN_MAX)
    throw new IngestError(401, 'invalid_identity', 'A signed identity token is required.')
  const claims = await siteIdentity(c.env, site, token, Math.floor(Date.now() / 1000))
  const limit = await c.env.PINS_READ.limit({ key: JSON.stringify([site.public_key, claims.sub]) })
  if (!limit.success) {
    c.header('Retry-After', '60')
    throw new IngestError(429, 'pins_limited', 'Please wait before refreshing pins again.')
  }
  const rawPage = c.req.query('page') ?? ''
  const pageKey = rawPage.length <= 2048 ? urlKey(rawPage) : null
  let pageOrigin: string | null = null
  try {
    pageOrigin = new URL(rawPage).origin
  } catch {
    /* Refused below. */
  }
  if (!pageKey || pageOrigin !== origin)
    throw new IngestError(400, 'invalid_page', 'The page must belong to the submitting origin.')
  // No reporter/account/owner parameter can widen this query. Dashboard owners
  // will use their account session, not a host-signed reporter identity.
  return c.json({ ok: true, ...(await reporterPins(c.env.DB, site, claims.sub, pageKey)) })
})

export default pins
