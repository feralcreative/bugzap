// Which page a report is about, as a key pins can be looked up by.
//
// A pin belongs to a page, and "the same page" has to survive the things that change
// between visits without changing the page: a tracking parameter, a trailing slash,
// an uppercase hostname, a scroll fragment. `urlKey` is that sameness, written down.

export type UrlKeyOptions = {
  /** Query parameters that DO change the page (`?tab=billing`). Everything else is
   *  dropped, for the same reason diagnostics drop query strings: on someone else's
   *  site we cannot tell a page parameter from a reset token. */
  keepQueryParams?: readonly string[]
  /** For single-page apps that route on the fragment (`#/settings`). Off by default,
   *  because on most sites the fragment is a scroll position. */
  hashRouting?: boolean
}

/** `https://Example.com/a/b/?utm=1#top` → `https://example.com/a/b`, or null when the
 *  input is not an absolute http(s) URL. */
export function urlKey(raw: string, opts: UrlKeyOptions = {}): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null

  // URL already lowercases the host and drops a default port.
  let key = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '') || ''}`

  const keep = new Set(opts.keepQueryParams ?? [])
  if (keep.size) {
    const kept = [...u.searchParams].filter(([k]) => keep.has(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    if (kept.length) key += `?${new URLSearchParams(kept).toString()}`
  }

  if (opts.hashRouting && u.hash.startsWith('#/')) key += u.hash.split('?')[0]
  return key.slice(0, 2048)
}

/**
 * `scheme://host[:port]`, normalized, or null.
 *
 * The form both sides compare: the `Origin` header a browser sends and the origins an
 * owner lists for their site. Input may be a bare origin or a full URL; a path is
 * ignored. Only http and https, and http only for localhost, so a site cannot be
 * configured to accept reports from a page anyone on the network could serve.
 */
export function normalizeOrigin(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol === 'https:') return u.origin
  if (u.protocol === 'http:' && isLocalHost(u.hostname)) return u.origin
  return null
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
}
