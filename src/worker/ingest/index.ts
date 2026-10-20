import { Hono } from 'hono'
import { redactDiagnostics, scrubUrls } from '../../core/diagnostics'
import { generateId, isPublicKey } from '../../core/ids'
import { parseReportPayload } from '../../core/payload'
import { SUBMIT_LIMIT } from '../../core/policy'
import { normalizeOrigin, urlKey } from '../../core/url'
import { siteIdentity } from '../identity'
import { allowsOrigin, findIngestSite, hourlyCount, reportExists, saveReport } from '../db/scoped'
import { checkRequestSize, IngestError, readPayloadPart, readReportForm } from './body'
import { prepareImages } from './images'

const ingest = new Hono<{ Bindings: Env }>()

ingest.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Vary', 'Origin')
  await next()
})

// Preflights carry no body/token. The widget includes ?site= in the API URL so
// CORS can still be checked against that site's exact origin allowlist.
ingest.options('/', async (c) => {
  const site = await findIngestSite(c.env.DB, c.req.query('site') ?? '')
  const origin = c.req.header('Origin') ?? ''
  if (!site?.enabled || normalizeOrigin(origin) !== origin || !(await allowsOrigin(c.env.DB, site, origin)))
    throw new IngestError(403, 'origin_forbidden', 'This origin cannot submit reports for that site.')
  const headers = (c.req.header('Access-Control-Request-Headers') ?? '')
    .toLowerCase()
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  if (c.req.header('Access-Control-Request-Method') !== 'POST' || headers.some((h) => h !== 'content-type'))
    throw new IngestError(403, 'origin_forbidden', 'This cross-origin request is not allowed.')
  c.header('Access-Control-Allow-Origin', origin)
  c.header('Access-Control-Allow-Methods', 'POST')
  c.header('Access-Control-Allow-Headers', 'Content-Type')
  return c.body(null, 204)
})

ingest.post('/', async (c) => {
  checkRequestSize(c.req.raw)
  const form = await readReportForm(c.req.raw)
  const raw = readPayloadPart(form)
  if (!isPublicKey(raw.site)) throw new IngestError(400, 'invalid_site_key', 'A public site key is required.')
  const site = await findIngestSite(c.env.DB, raw.site)
  if (!site) throw new IngestError(404, 'site_not_found', 'That site was not found.')
  const origin = c.req.header('Origin') ?? ''
  if (normalizeOrigin(origin) !== origin || !origin || !(await allowsOrigin(c.env.DB, site, origin)))
    throw new IngestError(403, 'origin_forbidden', 'This origin cannot submit reports for that site.')
  c.header('Access-Control-Allow-Origin', origin)
  if (!site.enabled) throw new IngestError(403, 'site_disabled', 'This site is not accepting reports.')
  c.header('Access-Control-Expose-Headers', 'Retry-After')
  const querySite = c.req.query('site')
  if (querySite !== undefined && querySite !== site.public_key)
    throw new IngestError(400, 'invalid_site_key', 'The site key does not match the request URL.')

  const now = Math.floor(Date.now() / 1000)
  const claims = await siteIdentity(c.env, site, raw.identity, now)
  const burst = await c.env.INGEST_BURST.limit({ key: JSON.stringify([site.public_key, claims.sub]) })
  if (!burst.success) {
    c.header('Retry-After', '10')
    throw new IngestError(429, 'burst_limited', 'Please wait a few seconds before submitting again.')
  }
  if ((await hourlyCount(c.env.DB, site, claims.sub, now)) >= SUBMIT_LIMIT) {
    c.header('Retry-After', '3600')
    throw new IngestError(429, 'hourly_limited', 'You can submit ten reports per site per hour.')
  }
  const parsed = parseReportPayload(raw)
  if (!parsed.ok) throw new IngestError(400, 'invalid_payload', parsed.error)
  const payload = parsed.value
  let pageOrigin: string | null = null
  try {
    pageOrigin = normalizeOrigin(new URL(payload.page.url).origin)
  } catch {
    /* Refused below. */
  }
  const pageKey = urlKey(payload.page.url)
  if (!pageKey || pageOrigin !== origin)
    throw new IngestError(400, 'invalid_page', 'The report page must belong to the submitting origin.')
  if (payload.screenshot.failed) payload.screenshot.failed = scrubUrls(payload.screenshot.failed)

  const publicId = generateId()
  const images = await prepareImages(form, payload, site, publicId)
  const diagnostics = redactDiagnostics(payload.diagnostics)
  const attemptedKeys: string[] = []
  let writingDatabase = false
  try {
    for (const image of images) {
      attemptedKeys.push(image.key)
      await c.env.SHOTS.put(image.key, image.data, { httpMetadata: { contentType: image.mime } })
    }
    writingDatabase = true
    await saveReport(c.env.DB, site, { publicId, claims, payload, pageKey, diagnostics, images, now })
  } catch (error) {
    // A lost database response is ambiguous: do not delete an image belonging to
    // a report that actually committed. If D1 cannot confirm, leave it for sweep.
    let committed = false
    let canClean = true
    if (writingDatabase) {
      try {
        committed = await reportExists(c.env.DB, site, publicId)
      } catch {
        canClean = false
      }
    }
    if (committed) return c.json({ ok: true, id: publicId }, 201)
    if (canClean && attemptedKeys.length) {
      try {
        await c.env.SHOTS.delete(attemptedKeys)
      } catch {
        console.error(JSON.stringify({ event: 'ingest_cleanup_failed', report: publicId }))
      }
    }
    // Never log the payload, identity, email, secret, URL, or raw binding error.
    if (error instanceof Error && error.message.includes('report_hourly_limit')) {
      c.header('Retry-After', '3600')
      throw new IngestError(429, 'hourly_limited', 'You can submit ten reports per site per hour.')
    }
    console.error(
      JSON.stringify({ event: canClean ? 'ingest_storage_failed' : 'ingest_commit_unknown', report: publicId }),
    )
    throw new IngestError(503, 'storage_unavailable', 'The report could not be saved. Please try again.')
  }
  return c.json({ ok: true, id: publicId }, 201)
})

export default ingest
