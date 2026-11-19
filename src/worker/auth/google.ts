import { base64UrlDecode, base64UrlEncode } from '../../core/identity'
import { normalizeEmail } from './allowlist'
import { generateToken, isToken } from './tokens'

// Sign in with Google: the OpenID Connect authorization-code flow, with PKCE.
//
// The browser is sent to Google carrying three random values, which are also kept
// in a short-lived cookie on that browser:
//
//   - `state` comes back on the callback and must match the cookie, so a callback
//     can only finish a sign-in that this same browser started (no login CSRF).
//   - `nonce` is echoed inside the ID token, so a token minted for another
//     sign-in cannot be replayed into this one.
//   - `verifier` is sent with the code exchange; Google only honours the code for
//     whoever holds the verifier whose hash went out in the first request.
//
// The ID token is read from Google's token endpoint over TLS, directly, in
// exchange for a code and the client secret. OpenID Connect Core 3.1.3.7 allows
// relying on that TLS connection instead of checking the token's signature, and
// this does. A token from anywhere else (a URL, a form, a header) is never trusted.

export const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
export const FLOW_TTL_S = 10 * 60
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

export type Flow = { state: string; nonce: string; verifier: string }

export const newFlow = (): Flow => ({ state: generateToken(), nonce: generateToken(), verifier: generateToken() })
export const packFlow = (flow: Flow) => `${flow.state}.${flow.nonce}.${flow.verifier}`

export function parseFlow(raw: unknown): Flow | null {
  if (typeof raw !== 'string') return null
  const [state, nonce, verifier, extra] = raw.split('.')
  return isToken(state) && isToken(nonce) && isToken(verifier) && extra === undefined
    ? { state, nonce, verifier }
    : null
}

export async function authorizeUrl(clientId: string, redirectUri: string, flow: Flow): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.verifier))
  const url = new URL(GOOGLE_AUTHORIZE)
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: base64UrlEncode(new Uint8Array(digest)),
    code_challenge_method: 'S256',
    // Always ask which account: owners often have a personal and a work one.
    prompt: 'select_account',
  }).toString()
  return url.href
}

export type GoogleIdentity = { sub: string; email: string; name: string | null }

/** The claims of an ID token, or null. Shape only; the caller decides what they mean. */
function readClaims(idToken: unknown): Record<string, unknown> | null {
  if (typeof idToken !== 'string' || idToken.length > 8192) return null
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  const bytes = base64UrlDecode(parts[1] ?? '')
  if (!bytes) return null
  try {
    const claims: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Exchanges the callback's code for an ID token and returns who it names, or
 * null for any failure. Every check that can fail is here: the audience (a token
 * issued to some other app is not a sign-in to this one), the issuer, the expiry,
 * the nonce, and that Google itself vouches for the email address.
 */
export async function googleIdentity(
  env: Pick<Env, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>,
  input: { code: string; redirectUri: string; flow: Flow; now: number },
): Promise<GoogleIdentity | null> {
  let body: unknown
  try {
    const response = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code_verifier: input.flow.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    body = await response.json()
  } catch {
    return null
  }
  const claims = readClaims(body && typeof body === 'object' ? (body as Record<string, unknown>).id_token : null)
  if (!claims) return null
  const { iss, aud, exp, nonce, sub, email_verified: verified, name } = claims
  if (typeof iss !== 'string' || !ISSUERS.includes(iss)) return null
  if (aud !== env.GOOGLE_CLIENT_ID) return null
  if (typeof exp !== 'number' || exp <= input.now) return null
  if (nonce !== input.flow.nonce) return null
  if (typeof sub !== 'string' || !/^[0-9A-Za-z_-]{1,255}$/.test(sub)) return null
  // Google sends a boolean; some of its older responses used the string.
  if (verified !== true && verified !== 'true') return null
  const email = normalizeEmail(claims.email)
  if (!email) return null
  // `email_verified` alone is not enough. Google only stands behind the address
  // for a Gmail account or a Google Workspace account, whose token carries the
  // Workspace domain as `hd`. Any other Google account is one somebody made with
  // an outside address, verified once, possibly long before that address changed
  // hands; trusting it would let a former holder pass a domain allowlist.
  const domain = email.slice(email.lastIndexOf('@') + 1)
  const workspace = typeof claims.hd === 'string' && claims.hd.toLowerCase() === domain
  if (!workspace && domain !== 'gmail.com') return null
  return { sub, email, name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : null }
}
