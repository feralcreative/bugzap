/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx'
import { ORIGINS_MAX, SITE_NAME_MAX, SITES_MAX } from '../../core/policy'
import type { SessionUser } from '../db/auth'
import type { AccountSite } from '../db/scoped'

// Hono JSX escapes every interpolated value. Nothing here uses raw HTML, and the
// page's CSP allows no script at all, so a site name or origin cannot run code.

type PageProps = { title: string; user?: SessionUser; narrow?: boolean; children?: Child }

export function Page({ title, user, narrow, children }: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{title} · Bugzap</title>
        <link rel="stylesheet" href="/dashboard.css" />
      </head>
      <body>
        <header class="top">
          <a class="brand" href="/">
            Bugzap
          </a>
          {user && (
            <div class="who">
              <span>{user.email}</span>
              <form method="post" action="/logout">
                <button type="submit">Sign out</button>
              </form>
            </div>
          )}
        </header>
        <main class={narrow ? 'narrow' : undefined}>{children}</main>
      </body>
    </html>
  )
}

export function LoginPage({ error, email }: { error?: string; email?: string }) {
  return (
    <Page title="Sign in" narrow>
      <h1>Sign in</h1>
      <p>Enter your email and we will send you a link that signs you&nbsp;in.</p>
      <form method="post" action="/login" class="card">
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email" maxlength={254} value={email} />
        <div class="actions">
          <button type="submit" class="primary">
            Email me a link
          </button>
        </div>
      </form>
    </Page>
  )
}

/** Shown for every well-formed address, allowed or not, so the page never says
 *  who is on the allowlist. */
export function LinkSentPage() {
  return (
    <Page title="Check your email" narrow>
      <h1>Check your email</h1>
      <p>If that address can sign in, a link is on its way. It works once and expires in 15&nbsp;minutes.</p>
      <p>
        <a href="/login">Use a different address</a>
      </p>
    </Page>
  )
}

export function ConfirmPage({ token }: { token: string }) {
  return (
    <Page title="Finish signing in" narrow>
      <h1>Finish signing in</h1>
      <p>Press the button to sign in on this&nbsp;device.</p>
      <form method="post" action="/login/confirm">
        <input type="hidden" name="token" value={token} />
        <button type="submit" class="primary">
          Sign in
        </button>
      </form>
    </Page>
  )
}

export function MessagePage({ title, message, user }: { title: string; message: string; user?: SessionUser }) {
  return (
    <Page title={title} user={user} narrow>
      <h1>{title}</h1>
      <p>{message}</p>
      <p>{user ? <a href="/sites">Back to your sites</a> : <a href="/login">Go to sign in</a>}</p>
    </Page>
  )
}

const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10)

export function SitesPage(props: {
  user: SessionUser
  sites: (AccountSite & { origins: number; pending: number })[]
  error?: string
  draft?: { name: string; origins: string }
}) {
  const { user, sites, error, draft } = props
  return (
    <Page title="Sites" user={user}>
      <h1>Sites</h1>
      {sites.length === 0 ? (
        <p>You have no sites yet. Create one to get its keys and the embed&nbsp;snippet.</p>
      ) : (
        <div class="card">
          <ul class="rows">
            {sites.map((site) => (
              <li>
                <a href={`/sites/${site.public_key}/reports`}>{site.name}</a>
                <span class="meta">
                  {site.pending === 1 ? '1 new report' : `${site.pending} new reports`} ·{' '}
                  <a href={`/sites/${site.public_key}`}>Keys and origins</a>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2 id="new">New site</h2>
      {sites.length >= SITES_MAX ? (
        <p>This account has reached its limit of {SITES_MAX}&nbsp;sites.</p>
      ) : (
        <form method="post" action="/sites" class="card">
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <label for="name">Name</label>
          <input id="name" name="name" type="text" required maxlength={SITE_NAME_MAX} value={draft?.name} />
          <label for="origins">Allowed origins</label>
          <textarea id="origins" name="origins" required placeholder="https://app.example.com">
            {draft?.origins}
          </textarea>
          <p class="hint">
            One per line, up to {ORIGINS_MAX}. Reports are accepted only from pages on these origins. Use HTTPS, or HTTP
            for&nbsp;localhost.
          </p>
          <div class="actions">
            <button type="submit" class="primary">
              Create site
            </button>
          </div>
        </form>
      )}
    </Page>
  )
}

function snippet(publicKey: string, api: string): string {
  return `<script>
  window.Bugzap =
    window.Bugzap ||
    function () {
      ;(window.Bugzap.q = window.Bugzap.q || []).push(arguments)
    }
  Bugzap('init', {
    site: '${publicKey}',
    identity: 'SERVER_SIGNED_IDENTITY_TOKEN',
  })
</script>
<script async src="${api}/v1/bugzap.js"></script>`
}

export function SitePage(props: {
  user: SessionUser
  site: AccountSite & { origins: string[] }
  api: string
  now: number
  /** Present only on the response to the request that created or rotated it. */
  secret?: { value: string; rotated: boolean }
  error?: string
}) {
  const { user, site, api, now, secret, error } = props
  const base = `/sites/${site.public_key}`
  const grace = site.previous_secret_expires_at && site.previous_secret_expires_at > now
  return (
    <Page title={site.name} user={user}>
      <p>
        <a href="/sites">← Sites</a> · <a href={`${base}/reports`}>Reports</a>
      </p>
      <h1>{site.name}</h1>

      {secret && (
        <div class="card notice">
          <h2>{secret.rotated ? 'New signing secret' : 'Signing secret'}</h2>
          <p>
            Copy it now and store it on your server. It is shown only this once; if you lose it, rotate to get
            a&nbsp;new&nbsp;one.
          </p>
          <code class="secret">{secret.value}</code>
          <p class="hint">
            Your server signs each reporter’s identity token with it. Never put it in a page or a mobile&nbsp;app.
          </p>
        </div>
      )}

      <h2>Public site key</h2>
      <p>
        <code>{site.public_key}</code>
      </p>

      <h2>Embed</h2>
      <p>Add this to each page, with a token your server signs for the signed-in&nbsp;user.</p>
      <pre>
        <code>{snippet(site.public_key, api)}</code>
      </pre>

      <h2>Allowed origins</h2>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="card">
        {site.origins.length === 0 ? (
          <p>No origins are allowed, so this site accepts no&nbsp;reports.</p>
        ) : (
          <ul class="rows">
            {site.origins.map((origin) => (
              <li>
                <code>{origin}</code>
                <form method="post" action={`${base}/origins/remove`}>
                  <input type="hidden" name="origin" value={origin} />
                  <button type="submit" class="link" aria-label={`Remove ${origin}`}>
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {site.origins.length < ORIGINS_MAX && (
          <form method="post" action={`${base}/origins`} class="inline">
            <div class="grow">
              <label for="origin">Add an origin</label>
              <input id="origin" name="origin" type="url" required placeholder="https://app.example.com" />
            </div>
            <button type="submit">Add</button>
          </form>
        )}
      </div>

      <h2>Signing secret</h2>
      <p>
        Rotating makes a new secret and shows it once. The current one keeps working for 24 hours, so pages that are
        already open keep&nbsp;reporting.
      </p>
      {grace && (
        <p class="meta">
          The previous secret still works until {new Date(site.previous_secret_expires_at! * 1000).toISOString()}.
          Rotating again ends it&nbsp;immediately.
        </p>
      )}
      <form method="post" action={`${base}/rotate`}>
        <button type="submit" class="danger">
          Rotate secret
        </button>
      </form>
    </Page>
  )
}
