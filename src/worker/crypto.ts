import { base64UrlDecode, base64UrlEncode } from '../core/identity'

const encoder = new TextEncoder()

async function kekKey(kek: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const bytes = base64UrlDecode(kek)
  if (!bytes || bytes.length !== 32) throw new Error('SITE_KEK must be a base64url-encoded 32-byte key')
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [usage])
}

// The public key is authenticated too: moving a ciphertext to another site's row
// makes it undecryptable. Each encryption gets a fresh 96-bit nonce.
export async function encryptSiteSecret(secret: string, kek: string, publicKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(publicKey) },
    await kekKey(kek, 'encrypt'),
    encoder.encode(secret),
  )
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(cipher))}`
}

export async function decryptSiteSecret(ciphertext: string, kek: string, publicKey: string): Promise<string> {
  const [version, nonce, data, extra] = ciphertext.split('.')
  const iv = base64UrlDecode(nonce ?? '')
  const cipher = base64UrlDecode(data ?? '')
  if (version !== 'v1' || extra !== undefined || iv?.length !== 12 || !cipher || cipher.length < 16)
    throw new Error('Invalid site secret envelope')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(publicKey) },
    await kekKey(kek, 'decrypt'),
    cipher,
  )
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plain)
}
