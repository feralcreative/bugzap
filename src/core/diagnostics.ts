// What the browser told us, shaped and redacted before it is stored.
//
// Ported from Routeloop's src/feedback/diagnostics.ts and the parseDiagnostics half
// of its policy.ts, which lived apart there only because the type sat beside the
// database enums. Here they are one module.
//
// **Nothing is stored unredacted.** `redactDiagnostics` is the only way in, and it
// runs in the Worker before the row is written, not on read and not in the view. A
// redaction applied at render time is not a redaction; the data is already stored
// and already in a backup.
//
// Three things this deliberately does NOT collect, each because collecting it is a
// privacy incident that looks like an ordinary field:
//
//   - Coordinates. Geolocation is recorded as a permission STATE and nothing else.
//   - Query strings and fragments. A host site's URLs routinely carry share ids,
//     reset tokens and search terms. The route PATTERN, which the host supplies,
//     carries everything diagnostics actually needs.
//   - Anything from localStorage or a cookie. Sizes only, never contents.
//
// Bugzap runs on other people's sites, which makes the second rule stricter here
// than it was in Routeloop: we cannot know which of a host's parameters are secret,
// so all of them are treated as if they were.

/**
 * What the browser told us, after redaction.
 *
 * Every field is optional because every field is best-effort: the widget enriches
 * and is not load-bearing, and a report submitted from a broken page is exactly the
 * report we most want to keep.
 *
 * `context` is the host's own block, set through `Bugzap('context', {...})`: a build
 * number, a feature flag, a plan name. Routeloop had fixed `prefs`, `health` and
 * `map` blocks; a tool that runs on any site cannot know what those would be.
 */
export type Diagnostics = {
  app?: { version?: string; pattern?: string; referrer?: string }
  device?: Record<string, string | number | boolean>
  context?: Record<string, string | number | boolean>
  errors?: { at?: number; kind?: string; message?: string; stack?: string }[]
  net?: {
    at?: number
    method?: string
    path?: string
    status?: number
    ms?: number
  }[]
  permissions?: Record<string, string>
}

/** Caps, applied on read as well as on write. A payload that grew past these in
 *  storage is truncated rather than rejected: it is already stored, and half a
 *  stack trace still names the file. */
export const DIAG_ERRORS_MAX = 25
export const DIAG_NET_MAX = 10
/** Keys in the host's context block. Enough for real use, few enough that a host
 *  cannot turn the diagnostics column into general storage. */
export const DIAG_CONTEXT_MAX = 30
const STRING_MAX = 2000
const STACK_MAX = 4000

// --- URL scrubbing -----------------------------------------------------------

/**
 * A URL with its query string and fragment removed, or the empty string.
 *
 * Handles a relative path as well as an absolute URL, because `referrer` is absolute
 * and `net[].path` may be either. Credentials in the authority are dropped too: rare,
 * but `https://user:pass@host/` is a legal URL and there is no reason for one to survive.
 */
export function stripUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  try {
    // A base is required for a relative path and ignored for an absolute URL.
    const u = new URL(s, 'https://x.invalid')
    const path = u.pathname || '/'
    if (u.origin === 'https://x.invalid' && !/^[a-z][a-z0-9+.-]*:/i.test(s)) return path
    return `${u.protocol}//${u.host}${path}`
  } catch {
    // Not parseable as a URL. Cut at the first delimiter by hand rather than
    // returning it whole: a malformed URL still carries its query string.
    return s.split(/[?#]/)[0] ?? ''
  }
}

// Anything URL-shaped inside free text: an error message, a stack frame, a
// console.error argument. A fetch failure message routinely embeds the full URL it
// failed on, query string and all.
// A slash is not a word character: a leading word boundary misses `/api?token`
// after whitespace and only starts matching at a later slash in longer paths.
const URL_IN_TEXT = /((?:https?:\/\/|\/)[^\s'"`)\]]+)/gi

/** Free text with every embedded URL stripped of its query string and fragment. */
export function scrubUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (m) => stripUrl(m) || m)
}

// --- Reading -----------------------------------------------------------------

function str(v: unknown, max = STRING_MAX): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
}

function num(v: unknown): number | undefined {
  const n = Number(v)
  return typeof v !== 'boolean' && v !== null && v !== '' && Number.isFinite(n) ? n : undefined
}

/** Flat maps of primitives, which is all the device and context blocks ever hold.
 *  Anything nested is dropped rather than walked. */
function flat(v: unknown, maxKeys = 40, keyMax = 40): Record<string, string | number | boolean> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (Object.keys(out).length >= maxKeys) break
    if (k.length > keyMax) continue
    if (typeof val === 'boolean' || (typeof val === 'number' && Number.isFinite(val))) out[k] = val
    else {
      const s = str(val, 300)
      if (s !== undefined) out[k] = s
    }
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * The stored blob, read leniently. **Never casts, never throws.**
 *
 * D1 stores this as TEXT, so a row written by an older build, a truncated request or
 * a hand-crafted one all arrive here as `unknown`. The dashboard must not 500 on one
 * malformed payload out of forty, and a report whose diagnostics are unreadable is
 * still a report worth reading. Anything this drops was already unusable.
 */
export function parseDiagnostics(raw: unknown): Diagnostics {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: Diagnostics = {}

  const app = (src.app && typeof src.app === 'object' ? src.app : {}) as Record<string, unknown>
  const version = str(app.version, 60)
  const pattern = str(app.pattern, 200)
  const referrer = str(app.referrer, 300)
  if (version || pattern || referrer)
    out.app = {
      ...(version && { version }),
      ...(pattern && { pattern }),
      ...(referrer && { referrer }),
    }

  const device = flat(src.device)
  if (device) out.device = device
  const context = flat(src.context, DIAG_CONTEXT_MAX)
  if (context) out.context = context

  const errors = Array.isArray(src.errors) ? src.errors : []
  const errOut: NonNullable<Diagnostics['errors']> = []
  for (const e of errors) {
    if (errOut.length >= DIAG_ERRORS_MAX) break
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const message = str(r.message)
    const kind = str(r.kind, 40)
    const stack = str(r.stack, STACK_MAX)
    const at = num(r.at)
    if (message || stack)
      errOut.push({
        ...(at !== undefined && { at }),
        ...(kind && { kind }),
        ...(message && { message }),
        ...(stack && { stack }),
      })
  }
  if (errOut.length) out.errors = errOut

  const net = Array.isArray(src.net) ? src.net : []
  const netOut: NonNullable<Diagnostics['net']> = []
  for (const n of net) {
    if (netOut.length >= DIAG_NET_MAX) break
    if (!n || typeof n !== 'object') continue
    const r = n as Record<string, unknown>
    // A request with no path says nothing, and an entry of pure timings is worse
    // than no entry: it looks like data.
    const path = str(r.path, 300)
    if (!path) continue
    const method = str(r.method, 10)
    const status = num(r.status)
    const ms = num(r.ms)
    const at = num(r.at)
    netOut.push({
      ...(at !== undefined && { at }),
      ...(method && { method }),
      path,
      ...(status !== undefined && { status }),
      ...(ms !== undefined && { ms }),
    })
  }
  if (netOut.length) out.net = netOut

  // Permission STATES only, and the one place the parser is strict rather than
  // lenient: anything that is not one of the three known states is dropped, so a
  // coordinate pair smuggled in under `permissions.geolocation` cannot survive a read
  // even if it somehow survived a write.
  const perms = (src.permissions && typeof src.permissions === 'object' ? src.permissions : {}) as Record<
    string,
    unknown
  >
  const permOut: Record<string, string> = {}
  for (const [k, v] of Object.entries(perms)) {
    if (k.length > 40) continue
    const s = str(v, 20)
    if (s === 'granted' || s === 'denied' || s === 'prompt') permOut[k] = s
  }
  if (Object.keys(permOut).length) out.permissions = permOut

  return out
}

// --- Redaction on the way in -------------------------------------------------

// A route pattern is `/projects/:id/edit`: colons and letters, no values. If a
// client sends a concrete URL where the pattern goes, it is not a pattern, and
// keeping it would defeat the point of having a separate field.
const PATTERN_OK = /^\/[A-Za-z0-9/:_.*-]*$/

/** A latitude/longitude pair in any of the forms a client might send one. Belt and
 *  braces on top of the strict permissions branch above: this catches a pair that
 *  arrived somewhere other than `permissions`. */
const COORD_PAIR = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/

/** Keys whose values are dropped outright wherever they appear, because there is no
 *  version of them we want. Matched case-insensitively on the whole key. The host's
 *  context block is where these would most plausibly arrive, set by a developer who
 *  meant well. */
const FORBIDDEN_KEYS = new Set([
  'lat',
  'lng',
  'lon',
  'latitude',
  'longitude',
  'coords',
  'coordinates',
  'position',
  'location',
  'email',
  'phone',
  'token',
  'secret',
  'password',
  'cookie',
  'authorization',
  'session',
  'apikey',
  'api_key',
])

function scrubFlat(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) continue
    if (typeof val === 'string') {
      // A string carrying a coordinate pair is dropped rather than trimmed: there is
      // no partial coordinate worth keeping, and a half-scrubbed one reads as clean.
      if (COORD_PAIR.test(val)) continue
      out[k] = scrubUrls(val)
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      out[k] = val
    }
  }
  return out
}

/**
 * The client payload, ready to store.
 *
 * Total and lenient in the same way parseDiagnostics is, and for a sharper reason:
 * it runs on the ingest path. A report must not be lost because the diagnostics blob
 * a broken browser produced was itself malformed; that is precisely the browser we
 * most want to hear from.
 */
export function redactDiagnostics(raw: unknown): Diagnostics {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const staged: Record<string, unknown> = {}

  const app = src.app
  if (app && typeof app === 'object' && !Array.isArray(app)) {
    const a = app as Record<string, unknown>
    const pattern = typeof a.pattern === 'string' ? (a.pattern.split(/[?#]/)[0] ?? '') : ''
    staged.app = {
      ...(typeof a.version === 'string' && { version: a.version }),
      // A concrete URL sent where the pattern goes is dropped, not stored.
      ...(pattern && PATTERN_OK.test(pattern) && { pattern }),
      ...(typeof a.referrer === 'string' && { referrer: stripUrl(a.referrer) }),
    }
  }

  for (const key of ['device', 'context'] as const) {
    const block = scrubFlat(src[key])
    if (block) staged[key] = block
  }

  const errors = Array.isArray(src.errors) ? src.errors : []
  staged.errors = errors.map((e) => {
    if (!e || typeof e !== 'object') return e
    const r = e as Record<string, unknown>
    return {
      ...r,
      ...(typeof r.message === 'string' && { message: scrubUrls(r.message) }),
      ...(typeof r.stack === 'string' && { stack: scrubUrls(r.stack) }),
    }
  })

  const net = Array.isArray(src.net) ? src.net : []
  staged.net = net.map((n) => {
    if (!n || typeof n !== 'object') return n
    const r = n as Record<string, unknown>
    return {
      ...r,
      ...(typeof r.path === 'string' && { path: stripUrl(r.path) }),
    }
  })

  // Passed through untouched: parseDiagnostics is strict here and accepts only
  // 'granted' / 'denied' / 'prompt', so a coordinate pair sent under this key cannot
  // survive the call below.
  staged.permissions = src.permissions

  // The single exit. Everything above stages a shape; this decides what a valid
  // payload is, and it is the same function the read path calls.
  return parseDiagnostics(staged)
}
