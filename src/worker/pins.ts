import { type Context, Hono } from 'hono'
import { isPublicKey } from '../core/ids'
import { IDENTITY_TOKEN_MAX } from '../core/identity'
import { normalizeOrigin, urlKey } from '../core/url'
import { verifyViewToken } from './auth/view-token'
import { allowsOrigin, findIngestSite, type IngestSite, reporterPins, viewedPin } from './db/scoped'
import { siteIdentity } from './identity'
import { IngestError } from './ingest/body'

type Ctx = Context<{ Bindings: Env }>

const pins = new Hono<{ Bindings: Env }>()
pins.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Vary', 'Origin')
  await next()
})

/**
 * Everything both pin reads share: the site, its origin allowlist, CORS, and the
 * page the caller is on. Returns a Response for a preflight, which carries no
 * token, and otherwise what the handler needs.
 */
async function gate(
  c: Ctx,
): Promise<Response | { site: IngestSite; pageKey: string; credential: (scheme: string) => string | null }> {
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
  const rawPage = c.req.query('page') ?? ''
  const pageKey = rawPage.length <= 2048 ? urlKey(rawPage) : null
  let pageOrigin: string | null = null
  try {
    pageOrigin = new URL(rawPage).origin
  } catch {
    /* Refused below. */
  }
  const authorization = c.req.header('Authorization') ?? ''
  return {
    site,
    // Checked by the handler after its token, so a caller without a valid token
    // learns nothing about which pages exist.
    pageKey: pageKey && pageOrigin === origin ? pageKey : '',
    credential: (scheme) => new RegExp(`^${scheme} ([^\\s]+)$`, 'i').exec(authorization)?.[1] ?? null,
  }
}

const invalidPage = () => new IngestError(400, 'invalid_page', 'The page must belong to the submitting origin.')

async function limit(c: Ctx, site: IngestSite, who: string) {
  const result = await c.env.PINS_READ.limit({ key: JSON.stringify([site.public_key, who]) })
  if (!result.success) {
    c.header('Retry-After', '60')
    throw new IngestError(429, 'pins_limited', 'Please wait before refreshing pins again.')
  }
}

// A reporter's own pins on this page, proved by the host-signed identity token.
pins.on(['GET', 'OPTIONS'], '/', async (c) => {
  const gated = await gate(c)
  if (gated instanceof Response) return gated
  const { site, pageKey, credential } = gated
  const token = credential('Bearer')
  if (!token || token.length > IDENTITY_TOKEN_MAX)
    throw new IngestError(401, 'invalid_identity', 'A signed identity token is required.')
  const claims = await siteIdentity(c.env, site, token, Math.floor(Date.now() / 1000))
  await limit(c, site, claims.sub)
  if (!pageKey) throw invalidPage()
  // No reporter/account/owner parameter can widen this query. Dashboard owners
  // use a view token on the route below, not a host-signed reporter identity.
  return c.json({ ok: true, ...(await reporterPins(c.env.DB, site, claims.sub, pageKey)) })
})

// One report's pin, for an owner who pressed "Open on page" in the dashboard.
// The token names the report; the site and page still have to match it.
pins.on(['GET', 'OPTIONS'], '/view', async (c) => {
  const gated = await gate(c)
  if (gated instanceof Response) return gated
  const { site, pageKey, credential } = gated
  const reportId = await verifyViewToken(c.env.SITE_KEK, credential('View'), Math.floor(Date.now() / 1000))
  if (!reportId) throw new IngestError(401, 'invalid_view_token', 'That view link has expired.')
  await limit(c, site, `view:${reportId}`)
  if (!pageKey) throw invalidPage()
  const pin = await viewedPin(c.env.DB, site, reportId, pageKey)
  // The same answer whether the report is on another site, another page, or gone.
  if (!pin) throw new IngestError(404, 'pin_not_found', 'That pin is not on this page.')
  return c.json({ ok: true, pin })
})

export default pins
