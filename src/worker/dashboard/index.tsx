/** @jsxImportSource hono/jsx */
import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { generateId, generatePublicKey, generateSecretKey, isPublicKey } from '../../core/ids'
import { ORIGINS_MAX, SECRET_GRACE_S, SITE_NAME_MAX, SITES_MAX } from '../../core/policy'
import { normalizeOrigin } from '../../core/url'
import { isAllowed } from '../auth/allowlist'
import { authorizeUrl, FLOW_TTL_S, googleIdentity, newFlow, packFlow, parseFlow } from '../auth/google'
import { generateToken, hashToken, isToken } from '../auth/tokens'
import { encryptSiteSecret } from '../crypto'
import {
  deleteSession,
  endSessionsFor,
  findSession,
  openGoogleSession,
  SESSION_TTL_S,
  type SessionUser,
} from '../db/auth'
import { accountSite, accountSites, addSiteOrigin, createSite, removeSiteOrigin, rotateSiteSecret } from '../db/scoped'
import { type App, type Ctx, now } from './context'
import { addReportRoutes } from './reports'
import { dashboardCss } from './style'
import { LoginPage, MessagePage, SitePage, SitesPage } from './views'

const dashboard = new Hono<App>()

// `__Host-` pins the cookie to this exact host over HTTPS with Path=/, so no
// sibling subdomain can set or shadow it. Browsers refuse that prefix without
// Secure, so plain-HTTP localhost dev uses an unprefixed name.
function cookieName(c: Ctx): string {
  return new URL(c.req.url).protocol === 'https:' ? '__Host-bz_session' : 'bz_session'
}

// The allowlist is rechecked on every request, not only at sign-in: taking an
// address off it ends that owner's sessions at once.
async function currentUser(c: Ctx): Promise<SessionUser | null> {
  const token = getCookie(c, cookieName(c))
  if (!isToken(token)) return null
  const user = await findSession(c.env.DB, await hashToken(token), now())
  return user && isAllowed(user.email, c.env.SIGNUP_ALLOWLIST) ? user : null
}

// No script runs on any dashboard page, so the CSP allows none. The referrer
// policy keeps dashboard URLs, including the sign-in callback's one-time code,
// from reaching another origin. It must not be `no-referrer`: under that policy
// a browser sends `Origin: null` on the page's own form posts.
const guard: MiddlewareHandler<App> = async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'same-origin')
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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

for (const path of ['/', '/login', '/login/*', '/logout', '/sites', '/sites/*', '/reports/*']) {
  dashboard.use(path, guard)
  dashboard.use(path, limitBody)
}
for (const path of ['/', '/sites', '/sites/*', '/reports/*']) dashboard.use(path, signedIn)

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

// The flow cookie follows the session cookie's naming rule, and for the same reason.
const flowCookie = (c: Ctx) => (new URL(c.req.url).protocol === 'https:' ? '__Host-bz_oauth' : 'bz_oauth')
const callbackUrl = (c: Ctx) => `${new URL(c.req.url).origin}/login/google/callback`

const refused = (c: Ctx, message: string, status: 400 | 403 | 503 = 400) =>
  c.html(<LoginPage error={message} />, status)

// A plain link starts the flow, not a form: the page's CSP limits form posts to
// this origin, and the next stop is Google.
dashboard.get('/login/google', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET)
    return refused(c, 'Google sign-in is not set up on this server.', 503)
  const flow = newFlow()
  const name = flowCookie(c)
  // Lax, not Strict: the callback is a navigation that arrives from Google.
  setCookie(c, name, packFlow(flow), {
    path: '/',
    httpOnly: true,
    secure: name.startsWith('__Host-'),
    sameSite: 'Lax',
    maxAge: FLOW_TTL_S,
  })
  return c.redirect(await authorizeUrl(c.env.GOOGLE_CLIENT_ID, callbackUrl(c), flow), 302)
})

dashboard.get('/login/google/callback', async (c) => {
  const name = flowCookie(c)
  const flow = parseFlow(getCookie(c, name))
  const state = c.req.query('state')
  const code = c.req.query('code')
  // The state must be the one this browser was given, checked before anything
  // else in the request is believed. Comparing hashes keeps the comparison from
  // leaking how much of a guess was right.
  if (!flow || !isToken(state) || (await hashToken(state)) !== (await hashToken(flow.state)))
    return refused(c, 'That sign-in attempt has expired. Try again.')
  // Single use from here on, whatever happens next. A request with the wrong
  // state leaves the cookie alone, so a stray link cannot cancel a sign-in that
  // is under way in another tab.
  deleteCookie(c, name, { path: '/', secure: name.startsWith('__Host-') })
  if (c.req.query('error')) return refused(c, 'Google sign-in was cancelled. Try again.')
  if (typeof code !== 'string' || !code || code.length > 2048) return refused(c, 'Google sign-in failed. Try again.')

  const identity = await googleIdentity(c.env, { code, redirectUri: callbackUrl(c), flow, now: now() })
  if (!identity) return refused(c, 'Google sign-in failed. Try again.')
  if (!isAllowed(identity.email, c.env.SIGNUP_ALLOWLIST)) {
    // Someone already known here whose address has moved off the allowlist: the
    // per-request check reads the address on file, which is now out of date, so
    // their older sessions are ended here.
    await endSessionsFor(c.env.DB, identity.sub)
    return refused(c, 'That Google account cannot sign in to Bugzap.', 403)
  }

  const session = generateToken()
  const opened = await openGoogleSession(c.env.DB, {
    ...identity,
    sessionHash: await hashToken(session),
    accountPublicId: generateId(),
    now: now(),
  })
  if (!opened) return refused(c, 'That Google account cannot sign in to Bugzap.', 403)
  const sessionName = cookieName(c)
  setCookie(c, sessionName, session, {
    path: '/',
    httpOnly: true,
    secure: sessionName.startsWith('__Host-'),
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

addReportRoutes(dashboard)

dashboard.onError((error, c) => {
  // Never the error itself: a binding error can carry SQL and bound values.
  console.error(JSON.stringify({ event: 'dashboard_failed', path: c.req.routePath, name: error.name }))
  return c.html(<MessagePage title="Something went wrong" message="Please try again in a moment." />, 503)
})

export default dashboard
