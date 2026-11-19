import { isPublicId } from '../../core/ids'
import { base64UrlDecode, base64UrlEncode } from '../../core/identity'

// "Open on page" lets an owner see a reporter's pin on the page it was dropped
// on. The owner is not that reporter and may not be signed in to the host site
// at all, so the dashboard hands the widget a short-lived token naming exactly
// one report. It grants a read of that one pin, on that one page, for 15 minutes.
//
// Stateless: an HMAC over the report id and the expiry, under a key derived from
// SITE_KEK with HKDF so the encryption key itself is never used to sign.

export const VIEW_TOKEN_TTL_S = 15 * 60
export const VIEW_TOKEN_MAX = 120
const encoder = new TextEncoder()

async function viewKey(kek: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const bytes = base64UrlDecode(kek)
  if (!bytes || bytes.length !== 32) throw new Error('SITE_KEK must be a base64url-encoded 32-byte key')
  const master = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode('bugzap view token v1') },
    master,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    [usage],
  )
}

export async function signViewToken(kek: string, reportId: string, expiresAt: number): Promise<string> {
  const message = `bzv1.${reportId}.${expiresAt}`
  const signature = await crypto.subtle.sign('HMAC', await viewKey(kek, 'sign'), encoder.encode(message))
  return `${message}.${base64UrlEncode(new Uint8Array(signature))}`
}

/** The report id the token names, or null if it is malformed, forged, or expired. */
export async function verifyViewToken(kek: string, token: unknown, now: number): Promise<string | null> {
  if (typeof token !== 'string' || token.length > VIEW_TOKEN_MAX) return null
  const [version, reportId, expires, signature, extra] = token.split('.')
  if (version !== 'bzv1' || extra !== undefined || !isPublicId(reportId) || !/^[1-9][0-9]{9,10}$/.test(expires ?? ''))
    return null
  const bytes = base64UrlDecode(signature ?? '')
  if (!bytes || bytes.length !== 32) return null
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify(
    'HMAC',
    await viewKey(kek, 'verify'),
    bytes,
    encoder.encode(`bzv1.${reportId}.${expires}`),
  )
  // The upper bound means a token is short-lived because the verifier says so,
  // not only because today's one caller mints it that way.
  const expiresAt = Number(expires)
  return valid && expiresAt > now && expiresAt <= now + VIEW_TOKEN_TTL_S + 60 ? reportId : null
}
