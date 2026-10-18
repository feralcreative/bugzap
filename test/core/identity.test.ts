// The host-signed identity token.
//
// Every refusal below is a real attack on JWT verifiers, not a hypothetical one. The
// header-trusting ones (alg:none, alg swapped) are the classic; the claim swap is the
// one specific to Bugzap, where an unsigned email would let anyone file reports as,
// and get replies sent to, someone else.
import { describe, expect, it } from 'vitest'
import {
  base64UrlDecode,
  base64UrlEncode,
  IDENTITY_CLOCK_SKEW_S,
  IDENTITY_MAX_LIFETIME_S,
  type IdentityClaims,
  signIdentity,
  verifyIdentity,
} from '../../src/core/identity'

// Fixture keys, shaped like real ones on purpose so the tests exercise the real format.
// They sign nothing outside this file.
const SECRET = 'bz_sk_0123456789abcdefghijABCDEFGHIJ' // gitleaks:allow
const OLD_SECRET = 'bz_sk_ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvu' // gitleaks:allow
const NOW = 1_800_000_000
const claims = (over: Partial<IdentityClaims> = {}): IdentityClaims => ({
  sub: 'user-42',
  email: 'ana@example.com',
  name: 'Ana',
  iat: NOW,
  exp: NOW + 3600,
  ...over,
})
const enc = (v: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(v)))

describe('verifyIdentity: what passes', () => {
  it('accepts a token signed with the current secret and returns its claims', async () => {
    const token = await signIdentity(claims(), SECRET)
    expect(await verifyIdentity(token, [SECRET], NOW)).toEqual({
      ok: true,
      claims: claims(),
    })
  })

  // Rotation: the previous secret stays valid for a grace period, so pages already
  // open with a token signed under it keep working.
  it('accepts a token signed with the previous secret during rotation', async () => {
    const token = await signIdentity(claims(), OLD_SECRET)
    expect((await verifyIdentity(token, [SECRET, OLD_SECRET], NOW)).ok).toBe(true)
  })

  it('accepts a token without email or name', async () => {
    const token = await signIdentity({ sub: 'u1', iat: NOW, exp: NOW + 60 }, SECRET)
    expect(await verifyIdentity(token, [SECRET], NOW)).toEqual({
      ok: true,
      claims: { sub: 'u1', iat: NOW, exp: NOW + 60 },
    })
  })

  it('tolerates a minute of clock skew either way', async () => {
    const early = await signIdentity(claims({ iat: NOW + IDENTITY_CLOCK_SKEW_S }), SECRET)
    const late = await signIdentity(claims({ exp: NOW - IDENTITY_CLOCK_SKEW_S }), SECRET)
    expect((await verifyIdentity(early, [SECRET], NOW)).ok).toBe(true)
    expect((await verifyIdentity(late, [SECRET], NOW)).ok).toBe(true)
  })
})

describe('verifyIdentity: what is refused', () => {
  it('refuses alg:none with no signature', async () => {
    const token = `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims())}.`
    expect(await verifyIdentity(token, [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'bad_algorithm',
    })
  })

  // A valid signature does not rescue a header that names another algorithm: the
  // header never decides how the token is verified.
  it('refuses any algorithm but HS256, even with a correct HS256 signature', async () => {
    const good = await signIdentity(claims(), SECRET)
    const [, p, s] = good.split('.')
    for (const alg of ['HS512', 'RS256', 'hs256', 'none']) {
      const token = `${enc({ alg, typ: 'JWT' })}.${p}.${s}`
      expect((await verifyIdentity(token, [SECRET], NOW)).ok, alg).toBe(false)
    }
  })

  it('refuses a token signed with another key', async () => {
    const token = await signIdentity(claims(), OLD_SECRET)
    expect(await verifyIdentity(token, [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  // THE BUGZAP-SPECIFIC ONE. A reporter with devtools edits the payload to become
  // someone else; the signature no longer matches.
  it('refuses a token whose claims were edited after signing', async () => {
    const [h, , s] = (await signIdentity(claims(), SECRET)).split('.')
    const forged = `${h}.${enc(claims({ email: 'ceo@example.com' }))}.${s}`
    expect(await verifyIdentity(forged, [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('refuses an expired token', async () => {
    const token = await signIdentity(claims({ iat: NOW - 7200, exp: NOW - 3600 }), SECRET)
    expect(await verifyIdentity(token, [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('refuses a token issued in the future', async () => {
    const token = await signIdentity(claims({ iat: NOW + 3600, exp: NOW + 7200 }), SECRET)
    expect(await verifyIdentity(token, [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    })
  })

  it('refuses a token that lives longer than the maximum', async () => {
    const token = await signIdentity(claims({ exp: NOW + IDENTITY_MAX_LIFETIME_S + 1 }), SECRET)
    expect(await verifyIdentity(token, [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'too_long_lived',
    })
  })

  it('refuses claims of the wrong shape, even when properly signed', async () => {
    const bad: Record<string, unknown>[] = [
      { ...claims(), sub: '' },
      { ...claims(), sub: 'x'.repeat(129) },
      { ...claims(), sub: 42 },
      { ...claims(), email: 'not an email' },
      { ...claims(), name: 'x'.repeat(101) },
      { ...claims(), exp: '1800003600' },
      { ...claims(), iat: 1.5 },
    ]
    for (const c of bad) {
      const token = await signIdentity(c as unknown as IdentityClaims, SECRET)
      expect(await verifyIdentity(token, [SECRET], NOW), JSON.stringify(c)).toEqual({ ok: false, reason: 'bad_claims' })
    }
  })

  it('refuses anything that is not three base64url parts of JSON objects', async () => {
    for (const junk of [undefined, null, 42, '', 'a.b', 'a.b.c.d', '!!.??.**', `${enc([1])}.${enc(claims())}.x`]) {
      expect(await verifyIdentity(junk, [SECRET], NOW), String(junk)).toEqual({
        ok: false,
        reason: 'malformed',
      })
    }
  })

  it('refuses an oversized token before doing any work on it', async () => {
    expect(await verifyIdentity('a'.repeat(5000), [SECRET], NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('refuses everything when there is no secret to check against', async () => {
    const token = await signIdentity(claims(), SECRET)
    expect(await verifyIdentity(token, [], NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })
})

describe('base64url', () => {
  it('round-trips every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(base64UrlDecode(base64UrlEncode(all))).toEqual(all)
  })

  it('uses the URL-safe alphabet with no padding', () => {
    expect(base64UrlEncode(Uint8Array.from([0xfb, 0xff]))).toBe('-_8')
  })

  it('refuses characters outside the alphabet', () => {
    expect(base64UrlDecode('ab+/')).toBeNull()
    expect(base64UrlDecode('ab=')).toBeNull()
  })
})
