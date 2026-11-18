import { base64UrlEncode } from '../../core/identity'

// Login and session tokens are 256 random bits. Only their SHA-256 is stored, so
// a copy of the database cannot be replayed as a sign-in. No salt or stretching
// is needed: there is nothing to guess in a uniformly random 256-bit value.
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function generateToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
}

export function isToken(raw: unknown): raw is string {
  return typeof raw === 'string' && TOKEN_PATTERN.test(raw)
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
