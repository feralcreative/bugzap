// Who a reporter is, as vouched for by the host site.
//
// Bugzap has no reporter accounts. The host site already knows who is signed in, so
// its server signs a short token saying so, with the site's secret key, and the
// widget passes it along with every report. This module verifies that token and,
// for the host-side helpers and the tests, makes one.
//
// The token is an HS256 JWT. Not because JWT is a good format (it is not), but
// because every host language already has a library that makes one, and hosts that
// would rather not take the dependency can produce it in four lines of HMAC.
//
// **Every claim is signed, not just the id.** Signing only `sub` would let anyone with
// devtools on the host page swap in someone else's email, which would turn the
// owner's "reply to reporter" into a way to mail strangers.
//
// What verification refuses, and why each check is here:
//
//   - Any `alg` but HS256, including `none`. The classic JWT failure is a verifier
//     that believes the header about how to verify.
//   - A bad signature, compared in constant time by crypto.subtle.verify.
//   - An expired token, or one issued in the future, with a minute of clock skew.
//   - A token whose lifetime exceeds IDENTITY_MAX_LIFETIME_S. A host that mints
//     year-long tokens has made every leaked page a year-long impersonation.
//   - Claims of the wrong shape or length.
//
// Several secrets may be tried, newest first: a site that rotates its secret keeps
// the previous one valid for a grace period, so pages already open keep working.

export const IDENTITY_MAX_LIFETIME_S = 7 * 24 * 60 * 60
export const IDENTITY_CLOCK_SKEW_S = 60
/** A real token is a few hundred bytes. The cap keeps a hostile one from costing
 *  anything to reject. */
export const IDENTITY_TOKEN_MAX = 4096

export type IdentityClaims = {
  sub: string
  email?: string
  name?: string
  iat: number
  exp: number
}

export type IdentityRefusal =
  | 'malformed'
  | 'bad_algorithm'
  | 'bad_signature'
  | 'bad_claims'
  | 'expired'
  | 'not_yet_valid'
  | 'too_long_lived'

export type IdentityResult = { ok: true; claims: IdentityClaims } | { ok: false; reason: IdentityRefusal }

const encoder = new TextEncoder()

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = base64UrlDecode(part)
  if (!bytes) return null
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
const optStr = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max)

function readClaims(p: Record<string, unknown>): IdentityClaims | null {
  if (typeof p.sub !== 'string' || p.sub.length < 1 || p.sub.length > 128) return null
  if (!optStr(p.email, 254) || !optStr(p.name, 100)) return null
  if (typeof p.email === 'string' && !/^[^\s@]+@[^\s@]+$/.test(p.email)) return null
  if (!isInt(p.iat) || !isInt(p.exp)) return null
  return {
    sub: p.sub,
    ...(typeof p.email === 'string' && { email: p.email }),
    ...(typeof p.name === 'string' && p.name.trim() && { name: p.name.trim() }),
    iat: p.iat,
    exp: p.exp,
  }
}

/**
 * Verify a host-signed identity token against one or more secrets, newest first.
 * `nowS` is unix seconds, passed in so the tests can move the clock.
 */
export async function verifyIdentity(token: unknown, secrets: string[], nowS: number): Promise<IdentityResult> {
  if (typeof token !== 'string' || token.length > IDENTITY_TOKEN_MAX) return { ok: false, reason: 'malformed' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [h, p, s] = parts as [string, string, string]

  const header = decodeJson(h)
  const payload = decodeJson(p)
  const sig = base64UrlDecode(s)
  if (!header || !payload || !sig) return { ok: false, reason: 'malformed' }

  // The header is read for one thing only: to refuse anything that is not HS256.
  // It never chooses how the token is verified.
  if (header.alg !== 'HS256') return { ok: false, reason: 'bad_algorithm' }

  const signed = encoder.encode(`${h}.${p}`)
  let valid = false
  for (const secret of secrets) {
    if (await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sig, signed)) {
      valid = true
      break
    }
  }
  if (!valid) return { ok: false, reason: 'bad_signature' }

  // Claims are checked only after the signature, so a forged token learns nothing
  // about which of its claims would have passed.
  const claims = readClaims(payload)
  if (!claims) return { ok: false, reason: 'bad_claims' }
  if (claims.exp - claims.iat > IDENTITY_MAX_LIFETIME_S) return { ok: false, reason: 'too_long_lived' }
  if (claims.exp + IDENTITY_CLOCK_SKEW_S < nowS) return { ok: false, reason: 'expired' }
  if (claims.iat - IDENTITY_CLOCK_SKEW_S > nowS) return { ok: false, reason: 'not_yet_valid' }
  return { ok: true, claims }
}

/**
 * Make a token. What a host's server does, here for utils/sign-identity.js and the
 * tests; the Worker itself never signs reporter identities.
 */
export async function signIdentity(claims: IdentityClaims, secret: string): Promise<string> {
  const json = (v: unknown) => base64UrlEncode(encoder.encode(JSON.stringify(v)))
  const unsigned = `${json({ alg: 'HS256', typ: 'JWT' })}.${json(claims)}`
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(unsigned))
  return `${unsigned}.${base64UrlEncode(new Uint8Array(sig))}`
}
