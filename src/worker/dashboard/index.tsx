/** @jsxImportSource hono/jsx */
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { generateId, generatePublicKey, generateSecretKey, isPublicKey } from '../../core/ids'
import { ORIGINS_MAX, SECRET_GRACE_S, SITE_NAME_MAX, SITES_MAX } from '../../core/policy'
import { normalizeOrigin } from '../../core/url'
import { isAllowed, normalizeEmail } from '../auth/allowlist'
import { generateToken, hashToken, isToken } from '../auth/tokens'
import { encryptSiteSecret } from '../crypto'
import {
  consumeLoginToken,
  createLoginToken,
  deleteSession,
  findSession,
  loginTokenIsLive,
  SESSION_TTL_S,
  type SessionUser,
} from '../db/auth'
import { accountSite, accountSites, addSiteOrigin, createSite, removeSiteOrigin, rotateSiteSecret } from '../db/scoped'
import { sendMail } from '../mail'
import { dashboardCss } from './style'
import { ConfirmPage, LinkSentPage, LoginPage, MessagePage, SitePage, SitesPage } from './views'

type App = { Bindings: Env; Variables: { user: SessionUser } }
type Ctx = Context<App>

const dashboard = new Hono<App>()
const now = () => Math.floor(Date.now() / 1000)

// `__Host-` pins the cookie to this exact host over HTTPS with Path=/, so no
// sibling subdomain can set or shadow it. Browsers refuse that prefix without
// Secure, so plain-HTTP localhost dev uses an unprefixed name.
function cookieName(c: Ctx): string {
  return new URL(c.req.url).protocol === 'https:' ? '__Host-bz_session' : 'bz_session'
}

// The allowlist is rechecked on every request, not only when a link is requested:
// taking an address off it ends that owner's sessions and unused links at once.
async function currentUser(c: Ctx): Promise<SessionUser | null> {
  const token = getCookie(c, cookieName(c))
  if (!isToken(token)) return null
  const user = await findSession(c.env.DB, await hashToken(token), now())
  return user && isAllowed(user.email, c.env.SIGNUP_ALLOWLIST) ? user : null
}

// No script runs on any dashboard page, so the CSP allows none. The referrer
// policy keeps the confirm page's URL, which carries the login token, from ever
// reaching another origin. It must not be `no-referrer`: under that policy a
// browser sends `Origin: null` on the page's own form posts.
const guard: MiddlewareHandler<App> = async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'same-origin')
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  )
  // Every state change is a same-origin form post. The session cookie is
  // SameSite=Lax, and this refuses anything a browser sends from another origin
  // (or from a client that says nothing about where it came from) before a
  // handler reads the body. Sec-Fetch-Site is set by the browser and cannot be
  // forged by a page; it covers a browser that withholds the origin as `null`.
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('Origin')
    const sameOrigin =
      origin === new URL(c.req.url).origin ||
      ((origin === undefined || origin === 'null') && c.req.header('Sec-Fetch-Site') === 'same-origin')
    if (!sameOrigin)
      return c.html(<MessagePage title="Request refused" message="That form was not sent from this site." />, 403)
  }
  await next()
}

const signedIn: MiddlewareHandler<App> = async (c, next) => {
  const user = await currentUser(c)
  if (!user) return c.redirect('/login', 303)
  c.set('user', user)
  await next()
}

const limitBody = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.html(<MessagePage title="Too large" message="That form was too large." />, 413),
})

for (const path of ['/', '/login', '/login/*', '/logout', '/sites', '/sites/*']) {
  dashboard.use(path, guard)
  dashboard.use(path, limitBody)
}
for (const path of ['/', '/sites', '/sites/*']) dashboard.use(path, signedIn)

dashboard.get('/dashboard.css', (c) => {
  c.header('Content-Type', 'text/css; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  c.header('X-Content-Type-Options', 'nosniff')
  return c.body(dashboardCss)
})

async function field(c: Ctx, name: string): Promise<string> {
  const value = (await c.req.parseBody())[name]
  return typeof value === 'string' ? value : ''
}

// --- Sign-in -------------------------------------------------------------------

dashboard.get('/login', async (c) => ((await currentUser(c)) ? c.redirect('/sites', 303) : c.html(<LoginPage />)))

dashboard.post('/login', async (c) => {
  const raw = await field(c, 'email')
  const email = normalizeEmail(raw)
  if (!email) return c.html(<LoginPage error="Enter a valid email address." email={raw.slice(0, 254)} />, 400)
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const limits = await Promise.all([
    c.env.LOGIN_BURST.limit({ key: `ip:${ip}` }),
    c.env.LOGIN_BURST.limit({ key: `email:${email}` }),
  ])
  if (limits.some((l) => !l.success)) {
    c.header('Retry-After', '60')
    return c.html(<LoginPage error="Too many attempts. Wait a minute and try again." email={email} />, 429)
  }
  if (isAllowed(email, c.env.SIGNUP_ALLOWLIST)) {
    // A storage failure here must look like every other answer, or a 503 would
    // say the address is on the allowlist.
    try {
      const token = generateToken()
      const created = await createLoginToken(c.env.DB, { email, tokenHash: await hashToken(token), now: now() })
      if (created) {
        const link = `${new URL(c.req.url).origin}/login/confirm?token=${token}`
        await sendMail(c.env, {
          to: email,
          subject: 'Your Bugzap sign-in link',
          text: `Open this link to sign in to Bugzap. It works once and expires in 15 minutes.\n\n${link}\n\nIf you did not ask for it, ignore this message.`,
        })
      }
    } catch {
      console.error(JSON.stringify({ event: 'login_link_failed' }))
    }
  }
  return c.html(<LinkSentPage />)
})

const expired = (c: Ctx) =>
  c.html(
    <MessagePage
      title="Link expired"
      message="That sign-in link has expired or was already used. Ask for a new one."
    />,
    400,
  )

// A GET only shows the button. Mail scanners and link previews follow links;
// they do not press buttons, so they cannot spend the token.
dashboard.get('/login/confirm', async (c) => {
  const token = c.req.query('token')
  if (!isToken(token) || !(await loginTokenIsLive(c.env.DB, await hashToken(token), now()))) return expired(c)
  return c.html(<ConfirmPage token={token} />)
})

dashboard.post('/login/confirm', async (c) => {
  const token = await field(c, 'token')
  if (!isToken(token)) return expired(c)
  const session = generateToken()
  const opened = await consumeLoginToken(c.env.DB, {
    tokenHash: await hashToken(token),
    sessionHash: await hashToken(session),
    accountPublicId: generateId(),
    now: now(),
  })
  if (!opened) return expired(c)
  const name = cookieName(c)
  setCookie(c, name, session, {
    path: '/',
    httpOnly: true,
    secure: name.startsWith('__Host-'),
    sameSite: 'Lax',
    maxAge: SESSION_TTL_S,
  })
  return c.redirect('/sites', 303)
})

dashboard.post('/logout', async (c) => {
  const name = cookieName(c)
  const token = getCookie(c, name)
  if (isToken(token)) await deleteSession(c.env.DB, await hashToken(token))
  deleteCookie(c, name, { path: '/', secure: name.startsWith('__Host-') })
  return c.redirect('/login', 303)
})

// --- Sites ---------------------------------------------------------------------

dashboard.get('/', (c) => c.redirect('/sites', 303))

dashboard.get('/sites', async (c) => {
  const user = c.get('user')
  return c.html(<SitesPage user={user} sites={await accountSites(c.env.DB, user.accountId)} />)
})

/** Each non-blank line as a normalized origin, or the first line that is not one. */
function parseOrigins(raw: string): { ok: true; origins: string[] } | { ok: false; bad: string } {
  const origins = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim()
    if (!text) continue
    const origin = normalizeOrigin(text)
    if (!origin) return { ok: false, bad: text.slice(0, 100) }
    origins.add(origin)
  }
  return { ok: true, origins: [...origins] }
}

const ORIGIN_HELP = 'Use an HTTPS origin such as https://app.example.com, or HTTP on localhost.'

dashboard.post('/sites', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const name = (typeof body.name === 'string' ? body.name : '').trim()
  const draft = { name: name.slice(0, SITE_NAME_MAX), origins: typeof body.origins === 'string' ? body.origins : '' }
  const refuse = async (error: string, status: 400 | 409 = 400) =>
    c.html(
      <SitesPage user={user} sites={await accountSites(c.env.DB, user.accountId)} error={error} draft={draft} />,
      status,
    )
  if (!name || name.length > SITE_NAME_MAX) return refuse(`Give the site a name of 1–${SITE_NAME_MAX} characters.`)
  const parsed = parseOrigins(draft.origins)
  if (!parsed.ok) return refuse(`“${parsed.bad}” is not an origin Bugzap can accept. ${ORIGIN_HELP}`)
  if (parsed.origins.length === 0) return refuse('List at least one origin the site is served from.')
  if (parsed.origins.length > ORIGINS_MAX) return refuse(`A site can allow at most ${ORIGINS_MAX} origins.`)

  const publicKey = generatePublicKey()
  const secret = generateSecretKey()
  const created = await createSite(c.env.DB, user.accountId, {
    publicKey,
    name,
    secretCipher: await encryptSiteSecret(secret, c.env.SITE_KEK, publicKey),
    origins: parsed.origins,
    now: now(),
  })
  if (!created) return refuse(`This account has reached its limit of ${SITES_MAX} sites.`, 409)
  const site = await accountSite(c.env.DB, user.accountId, publicKey)
  if (!site) return c.redirect('/sites', 303)
  // Rendered straight from the POST, never after a redirect: the secret exists in
  // plain text only in this one response and is not kept anywhere to show again.
  return c.html(
    <SitePage
      user={user}
      site={site}
      api={new URL(c.req.url).origin}
      now={now()}
      secret={{ value: secret, rotated: false }}
    />,
    201,
  )
})

const missing = (c: Ctx) =>
  c.html(<MessagePage title="Not found" message="That site does not exist." user={c.get('user')} />, 404)

/** The site named in the path, if this account owns it. Another account's key and
 *  a key that was never issued are the same answer. */
async function ownSite(c: Ctx) {
  const key = c.req.param('key')
  return isPublicKey(key) ? accountSite(c.env.DB, c.get('user').accountId, key) : null
}

dashboard.get('/sites/:key', async (c) => {
  const site = await ownSite(c)
  if (!site) return missing(c)
  return c.html(<SitePage user={c.get('user')} site={site} api={new URL(c.req.url).origin} now={now()} />)
})

dashboard.post('/sites/:key/rotate', async (c) => {
  const user = c.get('user')
  const site = await ownSite(c)
  if (!site) return missing(c)
  const secret = generateSecretKey()
  const rotated = await rotateSiteSecret(c.env.DB, user.accountId, site.public_key, {
    secretCipher: await encryptSiteSecret(secret, c.env.SITE_KEK, site.public_key),
    graceUntil: now() + SECRET_GRACE_S,
  })
  if (!rotated)
    return c.html(
      <SitePage
        user={user}
        site={site}
        api={new URL(c.req.url).origin}
        now={now()}
        error="The secret was rotated by another request at the same moment. Reload before rotating again."
      />,
      409,
    )
  const fresh = await accountSite(c.env.DB, user.accountId, site.public_key)
  if (!fresh) return missing(c)
  return c.html(
    <SitePage
      user={user}
      site={fresh}
      api={new URL(c.req.url).origin}
      now={now()}
      secret={{ value: secret, rotated: true }}
    />,
  )
})

dashboard.post('/sites/:key/origins', async (c) => {
  const user = c.get('user')
  const site = await ownSite(c)
  if (!site) return missing(c)
  const refuse = (error: string) =>
    c.html(<SitePage user={user} site={site} api={new URL(c.req.url).origin} now={now()} error={error} />, 400)
  const raw = (await field(c, 'origin')).trim()
  const origin = normalizeOrigin(raw)
  if (!origin) return refuse(`“${raw.slice(0, 100)}” is not an origin Bugzap can accept. ${ORIGIN_HELP}`)
  if (!site.origins.includes(origin)) {
    if (site.origins.length >= ORIGINS_MAX) return refuse(`A site can allow at most ${ORIGINS_MAX} origins.`)
    await addSiteOrigin(c.env.DB, user.accountId, site.public_key, origin)
  }
  return c.redirect(`/sites/${site.public_key}`, 303)
})

dashboard.post('/sites/:key/origins/remove', async (c) => {
  const site = await ownSite(c)
  if (!site) return missing(c)
  await removeSiteOrigin(c.env.DB, c.get('user').accountId, site.public_key, await field(c, 'origin'))
  return c.redirect(`/sites/${site.public_key}`, 303)
})

dashboard.onError((error, c) => {
  // Never the error itself: a binding error can carry SQL and bound values.
  console.error(JSON.stringify({ event: 'dashboard_failed', path: c.req.routePath, name: error.name }))
  return c.html(<MessagePage title="Something went wrong" message="Please try again in a moment." />, 503)
})

export default dashboard
