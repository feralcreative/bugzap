import { describe, expect, it } from 'vitest'
import {
  generateId,
  generatePublicKey,
  generateSecretKey,
  isPublicId,
  isPublicKey,
  isSecretKey,
} from '../../src/core/ids'

describe('generateId', () => {
  it('makes 22 base62 characters by default', () => {
    for (let i = 0; i < 50; i++) expect(generateId()).toMatch(/^[A-Za-z0-9]{22}$/)
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateId()))
    expect(seen.size).toBe(2000)
  })

  // Rejection sampling is there so the last few letters of the alphabet are not
  // under-represented. Loose bounds: this catches a modulo bias, not bad luck.
  it('uses the whole alphabet roughly evenly', () => {
    const counts = new Map<string, number>()
    const sample = Array.from({ length: 3000 }, () => generateId()).join('')
    for (const ch of sample) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    expect(counts.size).toBe(62)
    for (const [ch, n] of counts) expect(n, ch).toBeGreaterThan(800)
  })
})

describe('key shapes', () => {
  it('tells a public key from a secret one', () => {
    const pk = generatePublicKey()
    const sk = generateSecretKey()
    expect(isPublicKey(pk)).toBe(true)
    expect(isSecretKey(sk)).toBe(true)
    expect(isPublicKey(sk)).toBe(false)
    expect(isSecretKey(pk)).toBe(false)
  })

  it('refuses anything else', () => {
    for (const junk of ['', 'bz_pk_', 'bz_pk_short', 'bz_pk_ABCDEFGHIJKLMNOPQRSTU!', 42, null]) {
      expect(isPublicKey(junk)).toBe(false)
      expect(isSecretKey(junk)).toBe(false)
    }
  })

  it('checks public id shape and never existence', () => {
    expect(isPublicId(generateId())).toBe(true)
    expect(isPublicId('../etc/passwd')).toBe(false)
    expect(isPublicId('x'.repeat(23))).toBe(false)
  })
})
