import { describe, expect, it } from 'vitest'
import { normalizeOrigin, urlKey } from '../../src/core/url'

describe('urlKey', () => {
  it('ignores what does not change the page', () => {
    const key = 'https://example.com/pricing'
    for (const raw of [
      'https://example.com/pricing',
      'https://EXAMPLE.com/pricing/',
      'https://example.com:443/pricing',
      'https://example.com/pricing?utm_source=x',
      'https://example.com/pricing#faq',
    ]) {
      expect(urlKey(raw), raw).toBe(key)
    }
  })

  it('keeps the path case, which servers may treat as meaningful', () => {
    expect(urlKey('https://example.com/Docs/API')).toBe('https://example.com/Docs/API')
  })

  it('keys the root without a trailing slash', () => {
    expect(urlKey('https://example.com/')).toBe('https://example.com')
  })

  // A token in the query string must not become part of a stored key, so only the
  // parameters a site owner names survive, in a fixed order.
  it('keeps only the listed query parameters, sorted', () => {
    const opts = { keepQueryParams: ['tab', 'id'] }
    expect(urlKey('https://example.com/a?token=s3cret&tab=billing&id=7', opts)).toBe(
      'https://example.com/a?id=7&tab=billing',
    )
    expect(urlKey('https://example.com/a?token=s3cret', opts)).toBe('https://example.com/a')
  })

  it('keeps a hash route only when the site routes on the fragment', () => {
    expect(urlKey('https://app.example.com/#/settings?x=1')).toBe('https://app.example.com')
    expect(urlKey('https://app.example.com/#/settings?x=1', { hashRouting: true })).toBe(
      'https://app.example.com#/settings',
    )
    expect(urlKey('https://app.example.com/#top', { hashRouting: true })).toBe('https://app.example.com')
  })

  it('refuses what is not an absolute http(s) URL', () => {
    for (const raw of ['', '/relative', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url']) {
      expect(urlKey(raw), raw).toBeNull()
    }
  })
})

describe('normalizeOrigin', () => {
  it('reduces a URL or origin to scheme, host and port', () => {
    expect(normalizeOrigin('https://Example.com/some/path?q=1')).toBe('https://example.com')
    expect(normalizeOrigin('https://example.com:8443')).toBe('https://example.com:8443')
    expect(normalizeOrigin(' https://example.com ')).toBe('https://example.com')
  })

  // http is for local development only. A site that accepted reports from any http
  // origin would accept them from any page on a coffee-shop network.
  it('allows http for localhost and nothing else', () => {
    expect(normalizeOrigin('http://localhost:2834')).toBe('http://localhost:2834')
    expect(normalizeOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(normalizeOrigin('http://app.localhost')).toBe('http://app.localhost')
    expect(normalizeOrigin('http://example.com')).toBeNull()
  })

  it('refuses other schemes and junk', () => {
    for (const raw of ['null', 'file:///x', 'chrome-extension://abc', 'ftp://example.com', '']) {
      expect(normalizeOrigin(raw), raw).toBeNull()
    }
  })
})
