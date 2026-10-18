// The report as the widget sends it, checked before anything else touches it.
//
// Strict about structure and lenient about diagnostics, the same split Routeloop
// drew: a report whose required fields are wrong is not a report, but a report whose
// diagnostics are garbage is still worth keeping, so `diagnostics` is passed through
// as `unknown` for redactDiagnostics to deal with.
//
// The identity token is checked for shape only here. Whether it is genuine is
// ./identity.ts, which needs the site's secret.
import { type Anchor, parseAnchor } from './anchor'
import { isPublicKey } from './ids'
import { IDENTITY_TOKEN_MAX } from './identity'
import { BODY_MAX, BODY_MIN, isKind, type ReportKind } from './policy'

export const PAYLOAD_VERSION = 1
/** The JSON part of the request. Diagnostics are the bulk of it. */
export const REPORT_JSON_MAX = 64 * 1024

export const SCREENSHOT_MODES = ['auto', 'upload', 'none'] as const
export type ScreenshotMode = (typeof SCREENSHOT_MODES)[number]

export type ReportPayload = {
  v: 1
  site: string
  identity: string
  kind: ReportKind
  body: string
  page: { url: string; title?: string }
  /** Null for a report about the page as a whole, which is what a keyboard or
   *  screen-reader user files: there is nothing to point at with a mouse. */
  pin: Anchor | null
  screenshot: { mode: ScreenshotMode; failed?: string }
  diagnostics: unknown
}

export type PayloadResult = { ok: true; value: ReportPayload } | { ok: false; error: string }

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

function fail(error: string): PayloadResult {
  return { ok: false, error }
}

/** `raw` is the parsed JSON part. The caller has already capped its length. */
export function parseReportPayload(raw: unknown): PayloadResult {
  const p = obj(raw)
  if (!p) return fail('payload must be an object')
  if (p.v !== PAYLOAD_VERSION) return fail('unsupported payload version')
  if (!isPublicKey(p.site)) return fail('site must be a public key')
  if (typeof p.identity !== 'string' || !p.identity || p.identity.length > IDENTITY_TOKEN_MAX)
    return fail('identity token missing')
  if (!isKind(p.kind)) return fail('unknown kind')

  // Measured after trimming, so a body of spaces does not count as one.
  const body = typeof p.body === 'string' ? p.body.trim() : ''
  if (body.length < BODY_MIN) return fail('body too short')
  if (body.length > BODY_MAX) return fail('body too long')

  const page = obj(p.page)
  if (!page || typeof page.url !== 'string' || page.url.length > 2048) return fail('page url missing')
  if (!/^https?:\/\//i.test(page.url)) return fail('page url must be http(s)')
  const title = typeof page.title === 'string' ? page.title.trim().slice(0, 300) : ''

  let pin: Anchor | null = null
  if (p.pin !== null && p.pin !== undefined) {
    pin = parseAnchor(p.pin)
    if (!pin) return fail('pin is malformed')
  }

  const shot = obj(p.screenshot)
  const mode = shot?.mode
  if (mode !== 'auto' && mode !== 'upload' && mode !== 'none') return fail('unknown screenshot mode')
  const failed = typeof shot?.failed === 'string' ? shot.failed.slice(0, 200) : ''

  return {
    ok: true,
    value: {
      v: 1,
      site: p.site,
      identity: p.identity,
      kind: p.kind,
      body,
      page: { url: page.url, ...(title && { title }) },
      pin,
      screenshot: { mode, ...(failed && { failed }) },
      diagnostics: p.diagnostics,
    },
  }
}
