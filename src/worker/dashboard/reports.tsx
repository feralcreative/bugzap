/** @jsxImportSource hono/jsx */
import type { Hono } from 'hono'
import { isPublicId, isPublicKey } from '../../core/ids'
import {
  isState,
  isStatus,
  OWNER_NOTE_MAX,
  OWNER_TITLE_MAX,
  type ReportKind,
  type ReportState,
  STATES,
  STATUS_META,
  STATUSES,
  statusLabel,
} from '../../core/policy'
import { normalizeOrigin } from '../../core/url'
import { signViewToken, VIEW_TOKEN_TTL_S } from '../auth/view-token'
import type { SessionUser } from '../db/auth'
import {
  accountReport,
  accountSite,
  type InboxReport,
  type ReportDetail,
  reportAttachment,
  reportCounts,
  siteReports,
  updateReport,
} from '../db/scoped'
import { type App, type Ctx, now } from './context'
import { MessagePage, Page } from './views'

// What an owner calls each state. `pending` is the inbox: everything new lands
// there and stays private to its reporter and the owner.
const STATE_LABEL: Record<ReportState, string> = {
  pending: 'Inbox',
  published: 'Published',
  archived: 'Archived',
  spam: 'Spam',
}
const KIND_LABEL: Record<ReportKind, string> = { bug: 'Bug', idea: 'Idea', question: 'Question' }
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const

const when = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
const who = (r: { reporter_name: string | null; reporter_email: string | null }) =>
  r.reporter_name || r.reporter_email || 'Unnamed reporter'

const missing = (c: Ctx) =>
  c.html(<MessagePage title="Not found" message="That report does not exist." user={c.get('user')} />, 404)

function InboxPage(props: {
  user: SessionUser
  site: { public_key: string; name: string }
  state: ReportState
  /** True on any page after the first. */
  paged: boolean
  counts: Record<ReportState, number>
  reports: InboxReport[]
  more: boolean
}) {
  const { user, site, state, paged, counts, reports, more } = props
  const base = `/sites/${site.public_key}/reports`
  const link = (s: ReportState, before?: string) => `${base}?state=${s}${before ? `&before=${before}` : ''}`
  return (
    <Page title={`${site.name} reports`} user={user}>
      <p>
        <a href="/sites">← Sites</a> · <a href={`/sites/${site.public_key}`}>Keys and origins</a>
      </p>
      <h1>{site.name}</h1>
      <nav class="tabs" aria-label="Report states">
        {STATES.map((s) => (
          <a href={link(s)} aria-current={s === state ? 'page' : undefined}>
            {STATE_LABEL[s]} <span class="count">{counts[s]}</span>
          </a>
        ))}
      </nav>
      {reports.length === 0 ? (
        <p>{state === 'pending' && !paged ? 'No new reports.' : 'Nothing here.'}</p>
      ) : (
        <div class="card">
          <ul class="rows reports">
            {reports.map((r) => (
              <li>
                <div>
                  <a href={`/reports/${r.public_id}`}>{r.title || 'Untitled report'}</a>
                  <div class="meta">
                    {KIND_LABEL[r.kind]} · {statusLabel(r.status, r.kind)}
                    {r.priority !== null && ` · ${PRIORITIES[r.priority]}`} · {who(r)} · {when(r.created_at)}
                  </div>
                </div>
                <span class="meta">
                  {r.pinned ? 'Pinned' : 'Whole page'}
                  {r.shots > 0 && (r.shots === 1 ? ' · 1 image' : ` · ${r.shots} images`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(paged || more) && (
        <p>
          {paged && <a href={link(state)}>← Newest</a>}
          {paged && more && ' · '}
          {more && <a href={link(state, reports.at(-1)?.public_id)}>Older →</a>}
        </p>
      )}
    </Page>
  )
}

/** The parts of a stored anchor worth reading. Stored JSON is treated as data of
 *  unknown shape: only strings are shown, and JSX escapes them. */
function anchorSummary(json: string | null): [string, string][] {
  if (!json) return []
  try {
    const a = JSON.parse(json) as Record<string, unknown>
    const rows: [string, string][] = []
    if (typeof a.tag === 'string') rows.push(['Element', a.tag])
    if (typeof a.label === 'string' && a.label) rows.push(['Label', a.label])
    if (typeof a.text === 'string' && a.text) rows.push(['Text', a.text])
    if (typeof a.selector === 'string') rows.push(['Selector', a.selector])
    return rows.map(([k, v]) => [k, v.slice(0, 300)])
  } catch {
    return []
  }
}

function pretty(json: string | null): string | null {
  if (!json) return null
  try {
    const value: unknown = JSON.parse(json)
    return value && typeof value === 'object' && Object.keys(value).length ? JSON.stringify(value, null, 2) : null
  } catch {
    return null
  }
}

function ReportPage(props: { user: SessionUser; report: ReportDetail; error?: string; saved?: boolean }) {
  const { user, report: r, error, saved } = props
  const base = `/reports/${r.public_id}`
  const anchor = anchorSummary(r.anchor_json)
  const diagnostics = pretty(r.diagnostics_json)
  return (
    <Page title={r.title || 'Report'} user={user}>
      <p>
        <a href={`/sites/${r.site_key}/reports?state=${r.state}`}>
          ← {r.site_name} · {STATE_LABEL[r.state]}
        </a>
      </p>
      <h1>{r.title || 'Untitled report'}</h1>
      <p class="meta">
        {KIND_LABEL[r.kind]} from {who(r)}
        {r.reporter_email && (
          <>
            {' '}
            (<a href={`mailto:${encodeURIComponent(r.reporter_email)}`}>{r.reporter_email}</a>)
          </>
        )}{' '}
        · {when(r.created_at)}
      </p>

      <div class="card">
        <p class="report-body">{r.body}</p>
      </div>

      <h2>Where</h2>
      <dl class="facts">
        <dt>Page</dt>
        <dd>
          <a href={`${base}/open`} rel="noopener noreferrer" target="_blank">
            Open on page
          </a>
          {r.page_title && ` · ${r.page_title}`}
          <br />
          <code>{r.page_url}</code>
        </dd>
        {anchor.length === 0 && (
          <>
            <dt>Pin</dt>
            <dd>None. This report is about the whole page.</dd>
          </>
        )}
        {anchor.map(([label, value]) => (
          <>
            <dt>{label}</dt>
            <dd>
              <code>{value}</code>
            </dd>
          </>
        ))}
      </dl>

      <h2>Images</h2>
      {r.attachments.length === 0 ? (
        <p>
          No screenshot.
          {r.screenshot_failed && ` The automatic capture failed: ${r.screenshot_failed}`}
        </p>
      ) : (
        r.attachments.map((a) => (
          <figure>
            <a href={`${base}/images/${a.public_id}`} target="_blank" rel="noopener noreferrer">
              <img
                src={`${base}/images/${a.public_id}`}
                width={a.width}
                height={a.height}
                loading="lazy"
                alt={a.role === 'screenshot' ? 'Screenshot sent with the report' : 'Image attached by the reporter'}
              />
            </a>
            <figcaption class="meta">
              {a.role === 'screenshot'
                ? r.screenshot_mode === 'upload'
                  ? 'Screenshot uploaded by the reporter'
                  : 'Automatic screenshot'
                : 'Attachment'}{' '}
              · {a.width}×{a.height}
            </figcaption>
          </figure>
        ))
      )}

      <h2>Triage</h2>
      <form method="post" action={base} class="card">
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        {saved && <output class="ok">Saved.</output>}
        <label for="title">Title</label>
        <input id="title" name="title" type="text" required maxlength={OWNER_TITLE_MAX} value={r.title} />
        <div class="grid">
          <div>
            <label for="state">Where it sits</label>
            <select id="state" name="state">
              {STATES.map((s) => (
                <option value={s} selected={s === r.state}>
                  {STATE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label for="status">What the reporter is told</label>
            <select id="status" name="status">
              {STATUSES.map((s) => (
                <option value={s} selected={s === r.status}>
                  {statusLabel(s, r.kind)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label for="priority">Priority</label>
            <select id="priority" name="priority">
              <option value="" selected={r.priority === null}>
                None
              </option>
              {PRIORITIES.map((p, i) => (
                <option value={String(i)} selected={r.priority === i}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p class="hint">
          The reporter sees “{statusLabel(r.status, r.kind)}” on their pin: {STATUS_META[r.status].sub.toLowerCase()}.
          Archived and spam reports are hidden from the&nbsp;reporter.
        </p>
        <label for="note">Private note</label>
        <textarea id="note" name="note" maxlength={OWNER_NOTE_MAX}>
          {r.owner_note}
        </textarea>
        <p class="hint">Only people in this account see the&nbsp;note.</p>
        <div class="actions">
          <button type="submit" class="primary">
            Save
          </button>
        </div>
      </form>

      {diagnostics && (
        <details>
          <summary>Diagnostics</summary>
          <pre>
            <code>{diagnostics}</code>
          </pre>
        </details>
      )}
    </Page>
  )
}

export function addReportRoutes(dashboard: Hono<App>) {
  dashboard.get('/sites/:key/reports', async (c) => {
    const user = c.get('user')
    const key = c.req.param('key')
    const site = isPublicKey(key) ? await accountSite(c.env.DB, user.accountId, key) : null
    if (!site) return c.html(<MessagePage title="Not found" message="That site does not exist." user={user} />, 404)
    const wanted = c.req.query('state')
    const state: ReportState = isState(wanted) ? wanted : 'pending'
    const cursor = c.req.query('before')
    const before = isPublicId(cursor) ? cursor : undefined
    const [counts, list] = await Promise.all([
      reportCounts(c.env.DB, user.accountId, site.id),
      siteReports(c.env.DB, user.accountId, site.id, { state, before }),
    ])
    return c.html(
      <InboxPage
        user={user}
        site={site}
        state={state}
        paged={!!before}
        counts={counts}
        reports={list.reports}
        more={list.more}
      />,
    )
  })

  const own = async (c: Ctx) => {
    const id = c.req.param('id')
    return isPublicId(id) ? accountReport(c.env.DB, c.get('user').accountId, id) : null
  }

  dashboard.get('/reports/:id', async (c) => {
    const report = await own(c)
    if (!report) return missing(c)
    return c.html(<ReportPage user={c.get('user')} report={report} saved={c.req.query('saved') === '1'} />)
  })

  dashboard.post('/reports/:id', async (c) => {
    const user = c.get('user')
    const report = await own(c)
    if (!report) return missing(c)
    const body = await c.req.parseBody()
    const text = (name: string) => (typeof body[name] === 'string' ? (body[name] as string) : '')
    const title = text('title').replace(/\s+/g, ' ').trim()
    const note = text('note').trim()
    const state = text('state')
    const status = text('status')
    const priority = text('priority')
    const refuse = (error: string) => c.html(<ReportPage user={user} report={report} error={error} />, 400)
    if (!title || title.length > OWNER_TITLE_MAX)
      return refuse(`Give the report a title of 1–${OWNER_TITLE_MAX} characters.`)
    if (note.length > OWNER_NOTE_MAX) return refuse(`Keep the note under ${OWNER_NOTE_MAX} characters.`)
    if (!isState(state) || !isStatus(status) || !/^[0-3]?$/.test(priority))
      return refuse('Choose one of the listed options.')
    const saved = await updateReport(c.env.DB, user.accountId, report.public_id, {
      state,
      status,
      priority: priority === '' ? null : Number(priority),
      title,
      ownerNote: note || null,
      now: now(),
    })
    if (!saved) return missing(c)
    return c.redirect(`/reports/${report.public_id}?saved=1`, 303)
  })

  // "Open on page". The stored URL came from a reporter, so it is only followed
  // while its origin is still one this site allows: removing an origin ends every
  // link to it, and nothing else can be a redirect target. A pinned report gets
  // a view token in the fragment, which never reaches the host's server; the
  // widget reads it, removes it from the address bar, and draws that one pin.
  dashboard.get('/reports/:id/open', async (c) => {
    const report = await own(c)
    if (!report) return missing(c)
    const site = await accountSite(c.env.DB, c.get('user').accountId, report.site_key)
    let target: URL | null = null
    try {
      target = new URL(report.page_url)
    } catch {
      /* Refused below. */
    }
    if (!site || !target || !site.origins.includes(normalizeOrigin(target.origin) ?? ''))
      return c.html(
        <MessagePage
          title="Page not available"
          message="This report’s page is on an origin the site no longer allows, so it cannot be opened from here."
          user={c.get('user')}
        />,
        409,
      )
    if (report.anchor_json)
      target.hash = `bugzap-view=${await signViewToken(c.env.SITE_KEK, report.public_id, now() + VIEW_TOKEN_TTL_S)}`
    return c.redirect(target.href, 302)
  })

  // Reporter-supplied bytes, served from the dashboard's own origin. The stored
  // type is one of two image types the ingest sniffed, `nosniff` holds the browser
  // to it, and the sandbox policy means that even a file that somehow rendered as
  // a document could run nothing and reach nothing. The bucket itself is private:
  // this session-gated route is the only way an image leaves it.
  dashboard.get('/reports/:id/images/:image', async (c) => {
    const { id, image } = c.req.param()
    const row =
      isPublicId(id) && isPublicId(image) ? await reportAttachment(c.env.DB, c.get('user').accountId, id, image) : null
    const object = row ? await c.env.SHOTS.get(row.object_key) : null
    if (!row || !object) return missing(c)
    return new Response(object.body, {
      headers: {
        'Content-Type': row.mime === 'image/png' ? 'image/png' : 'image/jpeg',
        'Content-Length': String(object.size),
        'Content-Disposition': `inline; filename="bugzap-${image}.${row.mime === 'image/png' ? 'png' : 'jpg'}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'same-origin',
        'Cache-Control': 'private, no-store',
      },
    })
  })
}
