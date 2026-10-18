// Unguessable ids, and the shapes of the keys a site is given.
//
// Ported from Routeloop's src/maps/slug.ts. 22 base62 chars ≈ 131 bits of entropy,
// which is what makes a public id safe to put in a URL: knowing one report's id
// tells you nothing about the next. Rejection sampling keeps the distribution
// uniform (62 does not divide 256).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const LIMIT = 248 // largest multiple of 62 ≤ 256

export const ID_LENGTH = 22

export function generateId(length = ID_LENGTH): string {
  let out = ''
  while (out.length < length) {
    const bytes = new Uint8Array(length * 2)
    crypto.getRandomValues(bytes)
    for (const b of bytes) {
      if (b < LIMIT) out += ALPHABET[b % 62]
      if (out.length === length) break
    }
  }
  return out
}

/** True for a string shaped like a public id: base62 and no longer than the column.
 *  Shape only, never existence. */
export function isPublicId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9]{1,22}$/.test(raw)
}

// --- Site keys ---------------------------------------------------------------
//
// Two keys per site, prefixed so a human (and the widget) can tell them apart at a
// glance. The public key goes in every page's HTML and identifies the site; it
// proves nothing. The secret stays on the host's server and signs identity tokens.
// The prefix is what lets the widget refuse a secret pasted into a page by mistake.

export const PUBLIC_KEY_PREFIX = 'bz_pk_'
export const SECRET_KEY_PREFIX = 'bz_sk_'

/** 32 chars ≈ 190 bits. Longer than an id because it is a signing key, not a name. */
const SECRET_LENGTH = 32

export function generatePublicKey(): string {
  return PUBLIC_KEY_PREFIX + generateId()
}

export function generateSecretKey(): string {
  return SECRET_KEY_PREFIX + generateId(SECRET_LENGTH)
}

export function isPublicKey(raw: unknown): raw is string {
  return typeof raw === 'string' && /^bz_pk_[A-Za-z0-9]{22}$/.test(raw)
}

export function isSecretKey(raw: unknown): raw is string {
  return typeof raw === 'string' && /^bz_sk_[A-Za-z0-9]{32}$/.test(raw)
}
