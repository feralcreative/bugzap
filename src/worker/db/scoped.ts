import type { Diagnostics } from '../../core/diagnostics'
import type { ReportPayload } from '../../core/payload'
import {
  ORIGINS_MAX,
  type ReportKind,
  type ReportState,
  type ReportStatus,
  SITES_MAX,
  titleFrom,
} from '../../core/policy'
import { parseSavedPin, PINS_MAX, type SavedPin } from '../../core/pins'

export type IngestSite = {
  id: number
  account_id: number
  public_key: string
  secret_cipher: string
  previous_secret_cipher: string | null
  previous_secret_expires_at: number | null
  enabled: number
  identity_mode: 'guest' | 'signed'
}

// The public key selects a site, never an account supplied by the reporter. After
// this lookup all reads and writes carry this server-loaded tenant scope.
export function findIngestSite(db: D1Database, publicKey: string): Promise<IngestSite | null> {
  return db
    .prepare(
      `SELECT id, account_id, public_key, secret_cipher,
    previous_secret_cipher, previous_secret_expires_at, enabled, identity_mode FROM sites WHERE public_key = ?`,
    )
    .bind(publicKey)
    .first<IngestSite>()
}

export async function allowsOrigin(db: D1Database, site: IngestSite, origin: string): Promise<boolean> {
  return !!(await db
    .prepare('SELECT 1 FROM site_origins WHERE account_id = ? AND site_id = ? AND origin = ?')
    .bind(site.account_id, site.id, origin)
    .first())
}

export async function hourlyCount(db: D1Database, site: IngestSite, subject: string, now: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM reports r JOIN reporters p ON p.id = r.reporter_id
    AND p.site_id = r.site_id AND p.account_id = r.account_id
    WHERE r.account_id = ? AND r.site_id = ? AND p.subject = ? AND r.created_at > ?`,
    )
    .bind(site.account_id, site.id, subject, now - 3600)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/** Reports guests filed on this site in the last hour, all guests together. */
export async function guestHourlyCount(db: D1Database, site: IngestSite, now: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM reports r JOIN reporters p ON p.id = r.reporter_id
    AND p.site_id = r.site_id AND p.account_id = r.account_id
    WHERE r.account_id = ? AND r.site_id = ? AND r.created_at > ? AND p.subject LIKE 'guest:%'`,
    )
    .bind(site.account_id, site.id, now - 3600)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export type StoredImage = {
  publicId: string
  key: string
  role: 'screenshot' | 'attachment'
  mime: string
  bytes: number
  width: number
  height: number
}

export async function reportExists(db: D1Database, site: IngestSite, publicId: string): Promise<boolean> {
  return !!(await db
    .prepare('SELECT 1 FROM reports WHERE account_id = ? AND site_id = ? AND public_id = ?')
    .bind(site.account_id, site.id, publicId)
    .first())
}

export async function saveReport(
  db: D1Database,
  site: IngestSite,
  input: {
    publicId: string
    /** The reporter, signed or guest. */
    claims: { sub: string; email?: string; name?: string }
    payload: ReportPayload
    pageKey: string
    diagnostics: Diagnostics
    images: StoredImage[]
    now: number
  },
): Promise<void> {
  const { publicId, claims, payload, pageKey, diagnostics, images, now } = input
  const scope = [site.account_id, site.id]
  const statements = [
    db
      .prepare(
        `INSERT INTO reporters (account_id, site_id, subject, email, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (site_id, subject) DO UPDATE SET
      email = excluded.email, name = excluded.name, updated_at = excluded.updated_at`,
      )
      .bind(...scope, claims.sub, claims.email ?? null, claims.name ?? null, now, now),
    db
      .prepare(
        `INSERT INTO reports (public_id, account_id, site_id, reporter_id, kind, title, body,
      page_url, page_key, page_title, screenshot_mode, screenshot_failed, created_at, updated_at)
      VALUES (?, ?, ?, (SELECT id FROM reporters WHERE account_id = ? AND site_id = ? AND subject = ?),
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        publicId,
        ...scope,
        ...scope,
        claims.sub,
        payload.kind,
        titleFrom(payload.body),
        payload.body,
        pageKey,
        pageKey,
        payload.page.title ?? null,
        payload.screenshot.mode,
        payload.screenshot.failed ?? null,
        now,
        now,
      ),
  ]
  // No last_insert_rowid(): each dependent row resolves this report by its public
  // id inside the same atomic batch. Concurrent reports cannot steal its children.
  const reportId = '(SELECT id FROM reports WHERE account_id = ? AND site_id = ? AND public_id = ?)'
  if (payload.pin) {
    statements.push(
      db
        .prepare(
          `INSERT INTO pins (account_id, site_id, report_id, anchor_json)
      VALUES (?, ?, ${reportId}, ?)`,
        )
        .bind(...scope, ...scope, publicId, JSON.stringify(payload.pin)),
    )
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO diagnostics (account_id, site_id, report_id, data_json)
    VALUES (?, ?, ${reportId}, ?)`,
      )
      .bind(...scope, ...scope, publicId, JSON.stringify(diagnostics)),
  )
  for (const image of images) {
    statements.push(
      db
        .prepare(
          `INSERT INTO attachments (public_id, account_id, site_id, report_id,
      role, object_key, mime, bytes, width, height, created_at) VALUES (?, ?, ?, ${reportId}, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          image.publicId,
          ...scope,
          ...scope,
          publicId,
          image.role,
          image.key,
          image.mime,
          image.bytes,
          image.width,
          image.height,
          now,
        ),
    )
  }
  await db.batch(statements)
}

export async function reporterPins(
  db: D1Database,
  site: IngestSite,
  subject: string,
  pageKey: string,
): Promise<{ pins: SavedPin[]; truncated: boolean }> {
  const { results } = await db
    .prepare(
      `SELECT r.public_id AS id, r.kind, r.status, r.title, r.body, p.anchor_json
    FROM reports r JOIN reporters author ON author.account_id = r.account_id AND author.site_id = r.site_id AND author.id = r.reporter_id
    JOIN pins p ON p.account_id = r.account_id AND p.site_id = r.site_id AND p.report_id = r.id
    WHERE r.account_id = ? AND r.site_id = ? AND author.subject = ? AND r.page_key = ?
      AND r.state IN ('pending', 'published') ORDER BY r.id DESC LIMIT ?`,
    )
    .bind(site.account_id, site.id, subject, pageKey, PINS_MAX + 1)
    .all<{ id: string; kind: string; status: string; title: string; body: string; anchor_json: string }>()
  const pins: SavedPin[] = []
  for (const row of results.slice(0, PINS_MAX)) {
    try {
      const pin = parseSavedPin({ ...row, anchor: JSON.parse(row.anchor_json) })
      if (pin) pins.push(pin)
    } catch {
      /* A damaged historical anchor must not break the rest of the page. */
    }
  }
  return { pins, truncated: results.length > PINS_MAX }
}

// --- Dashboard: an owner's sites ---------------------------------------------
//
// Every function below takes the account id from the session, never from the
// request, and repeats it in each WHERE. A site key belonging to another account
// therefore matches no row, and the dashboard answers 404 exactly as it would for
// a key that does not exist.

export type AccountSite = {
  id: number
  public_key: string
  name: string
  enabled: number
  created_at: number
  previous_secret_expires_at: number | null
  identity_mode: 'guest' | 'signed'
}

export function accountSites(
  db: D1Database,
  accountId: number,
): Promise<(AccountSite & { origins: number; pending: number })[]> {
  return db
    .prepare(
      `SELECT s.id, s.public_key, s.name, s.enabled, s.created_at, s.previous_secret_expires_at, s.identity_mode,
      (SELECT count(*) FROM site_origins o WHERE o.account_id = s.account_id AND o.site_id = s.id) AS origins,
      (SELECT count(*) FROM reports r WHERE r.account_id = s.account_id AND r.site_id = s.id AND r.state = 'pending') AS pending
    FROM sites s WHERE s.account_id = ? ORDER BY s.id`,
    )
    .bind(accountId)
    .all<AccountSite & { origins: number; pending: number }>()
    .then((r) => r.results)
}

export async function accountSite(
  db: D1Database,
  accountId: number,
  publicKey: string,
): Promise<(AccountSite & { origins: string[] }) | null> {
  const site = await db
    .prepare(
      `SELECT id, public_key, name, enabled, created_at, previous_secret_expires_at, identity_mode
    FROM sites WHERE account_id = ? AND public_key = ?`,
    )
    .bind(accountId, publicKey)
    .first<AccountSite>()
  if (!site) return null
  const { results } = await db
    .prepare('SELECT origin FROM site_origins WHERE account_id = ? AND site_id = ? ORDER BY origin')
    .bind(accountId, site.id)
    .all<{ origin: string }>()
  return { ...site, origins: results.map((r) => r.origin) }
}

/** False when the account is already at SITES_MAX; nothing is written then. */
export async function createSite(
  db: D1Database,
  accountId: number,
  input: {
    publicKey: string
    name: string
    secretCipher: string
    origins: string[]
    identityMode: 'guest' | 'signed'
    now: number
  },
): Promise<boolean> {
  const { publicKey, name, secretCipher, origins, identityMode, now } = input
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO sites (account_id, public_key, name, secret_cipher, identity_mode, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM sites WHERE account_id = ?) < ?`,
      )
      .bind(accountId, publicKey, name, secretCipher, identityMode, now, accountId, SITES_MAX),
    // Resolved through the row above: when the limit refused it, these insert nothing.
    ...origins.slice(0, ORIGINS_MAX).map((origin) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO site_origins (account_id, site_id, origin)
        SELECT account_id, id, ? FROM sites WHERE account_id = ? AND public_key = ?`,
        )
        .bind(origin, accountId, publicKey),
    ),
  ])
  return (results[0]?.meta.changes ?? 0) === 1
}

/**
 * Replaces the signing secret and keeps the one it replaces valid until
 * `graceUntil`, so pages already open keep reporting. Rotating again inside the
 * grace period ends the older secret at once: only one previous secret is kept.
 *
 * Only a site that requires signed identity has a secret worth rotating, and the
 * mode is part of the swap: a rotation can never land on top of a switch to
 * signed identity, which installs its own fresh secret.
 *
 * Compare-and-swap on the secret that was current when this request read it. Of
 * two rotations sent at once (a double-click), one wins and the other returns
 * false, so no response ever shows as "new" a secret that is already the old one.
 */
export async function rotateSiteSecret(
  db: D1Database,
  accountId: number,
  publicKey: string,
  input: { secretCipher: string; graceUntil: number },
): Promise<boolean> {
  const current = await db
    .prepare("SELECT secret_cipher FROM sites WHERE account_id = ? AND public_key = ? AND identity_mode = 'signed'")
    .bind(accountId, publicKey)
    .first<{ secret_cipher: string }>()
  if (!current) return false
  const result = await db
    .prepare(
      `UPDATE sites SET previous_secret_cipher = secret_cipher, previous_secret_expires_at = ?, secret_cipher = ?
    WHERE account_id = ? AND public_key = ? AND secret_cipher = ? AND identity_mode = 'signed'`,
    )
    .bind(input.graceUntil, input.secretCipher, accountId, publicKey, current.secret_cipher)
    .run()
  return result.meta.changes === 1
}

/**
 * Changes who may report. Moving to 'signed' also installs a fresh signing secret
 * and drops any previous one: a site that was open to guests may never have had
 * its first secret copied down, so the owner is shown this one and starts clean.
 */
export async function setSiteIdentityMode(
  db: D1Database,
  accountId: number,
  publicKey: string,
  input: { mode: 'guest' } | { mode: 'signed'; secretCipher: string },
): Promise<boolean> {
  const result =
    input.mode === 'guest'
      ? await db
          .prepare("UPDATE sites SET identity_mode = 'guest' WHERE account_id = ? AND public_key = ?")
          .bind(accountId, publicKey)
          .run()
      : await db
          .prepare(
            `UPDATE sites SET identity_mode = 'signed', secret_cipher = ?, previous_secret_cipher = NULL,
          previous_secret_expires_at = NULL WHERE account_id = ? AND public_key = ? AND identity_mode = 'guest'`,
          )
          .bind(input.secretCipher, accountId, publicKey)
          .run()
  return result.meta.changes === 1
}

/** Adding an origin the site already allows is a no-op. The count guard backs up
 *  the handler's own check against two concurrent adds. */
export async function addSiteOrigin(db: D1Database, accountId: number, publicKey: string, origin: string) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO site_origins (account_id, site_id, origin)
    SELECT s.account_id, s.id, ? FROM sites s WHERE s.account_id = ? AND s.public_key = ?
      AND (SELECT count(*) FROM site_origins o WHERE o.account_id = s.account_id AND o.site_id = s.id) < ?`,
    )
    .bind(origin, accountId, publicKey, ORIGINS_MAX)
    .run()
}

export async function removeSiteOrigin(db: D1Database, accountId: number, publicKey: string, origin: string) {
  await db
    .prepare(
      `DELETE FROM site_origins WHERE account_id = ? AND origin = ?
      AND site_id = (SELECT id FROM sites WHERE account_id = ? AND public_key = ?)`,
    )
    .bind(accountId, origin, accountId, publicKey)
    .run()
}

// --- Dashboard: an owner's reports ----------------------------------------------
//
// The same rule as the sites above: the account id comes from the session and is
// in every WHERE, so a report id from another account matches nothing.

export const INBOX_PAGE = 50

export type InboxReport = {
  public_id: string
  kind: ReportKind
  state: ReportState
  status: ReportStatus
  title: string
  priority: number | null
  page_url: string
  created_at: number
  reporter_name: string | null
  reporter_email: string | null
  reporter_subject: string
  pinned: number
  shots: number
}

/** How many reports the site holds in each state, for the inbox tabs. */
export async function reportCounts(db: D1Database, accountId: number, siteId: number) {
  const { results } = await db
    .prepare('SELECT state, count(*) AS n FROM reports WHERE account_id = ? AND site_id = ? GROUP BY state')
    .bind(accountId, siteId)
    .all<{ state: ReportState; n: number }>()
  const counts: Record<ReportState, number> = { pending: 0, published: 0, archived: 0, spam: 0 }
  for (const row of results) counts[row.state] = row.n
  return counts
}

/**
 * Newest first, one page at a time. `before` is the public id of the last report
 * on the previous page: paging by position would repeat or skip rows whenever a
 * report arrives or is moved while the owner is reading. Asks for one row more
 * than a page so the caller knows whether another page exists without a count.
 */
export async function siteReports(
  db: D1Database,
  accountId: number,
  siteId: number,
  input: { state: ReportState; before?: string },
): Promise<{ reports: InboxReport[]; more: boolean }> {
  const { results } = await db
    .prepare(
      `SELECT r.public_id, r.kind, r.state, r.status, r.title, r.priority, r.page_url, r.created_at,
      p.name AS reporter_name, p.email AS reporter_email, p.subject AS reporter_subject,
      EXISTS (SELECT 1 FROM pins x WHERE x.account_id = r.account_id AND x.report_id = r.id) AS pinned,
      (SELECT count(*) FROM attachments a WHERE a.account_id = r.account_id AND a.report_id = r.id) AS shots
    FROM reports r JOIN reporters p ON p.account_id = r.account_id AND p.site_id = r.site_id AND p.id = r.reporter_id
    WHERE r.account_id = ?1 AND r.site_id = ?2 AND r.state = ?3
      AND (?4 IS NULL OR r.id < (SELECT id FROM reports WHERE account_id = ?1 AND site_id = ?2 AND public_id = ?4))
    ORDER BY r.id DESC LIMIT ?5`,
    )
    .bind(accountId, siteId, input.state, input.before ?? null, INBOX_PAGE + 1)
    .all<InboxReport>()
  return { reports: results.slice(0, INBOX_PAGE), more: results.length > INBOX_PAGE }
}

export type ReportAttachment = {
  public_id: string
  role: 'screenshot' | 'attachment'
  mime: string
  bytes: number
  width: number
  height: number
}

export type ReportDetail = InboxReport & {
  id: number
  site_id: number
  site_key: string
  site_name: string
  body: string
  owner_note: string | null
  page_key: string
  page_title: string | null
  screenshot_mode: string
  screenshot_failed: string | null
  updated_at: number
  anchor_json: string | null
  diagnostics_json: string | null
  attachments: ReportAttachment[]
}

export async function accountReport(db: D1Database, accountId: number, publicId: string): Promise<ReportDetail | null> {
  const report = await db
    .prepare(
      `SELECT r.id, r.site_id, r.public_id, r.kind, r.state, r.status, r.title, r.priority, r.body, r.owner_note,
      r.page_url, r.page_key, r.page_title, r.screenshot_mode, r.screenshot_failed, r.created_at, r.updated_at,
      s.public_key AS site_key, s.name AS site_name,
      p.name AS reporter_name, p.email AS reporter_email, p.subject AS reporter_subject,
      x.anchor_json, d.data_json AS diagnostics_json
    FROM reports r JOIN sites s ON s.account_id = r.account_id AND s.id = r.site_id
    JOIN reporters p ON p.account_id = r.account_id AND p.site_id = r.site_id AND p.id = r.reporter_id
    LEFT JOIN pins x ON x.account_id = r.account_id AND x.site_id = r.site_id AND x.report_id = r.id
    LEFT JOIN diagnostics d ON d.account_id = r.account_id AND d.site_id = r.site_id AND d.report_id = r.id
    WHERE r.account_id = ? AND r.public_id = ?`,
    )
    .bind(accountId, publicId)
    .first<Omit<ReportDetail, 'attachments' | 'pinned' | 'shots'>>()
  if (!report) return null
  const { results } = await db
    .prepare(
      `SELECT public_id, role, mime, bytes, width, height FROM attachments
    WHERE account_id = ? AND report_id = ? ORDER BY role DESC, id`,
    )
    .bind(accountId, report.id)
    .all<ReportAttachment>()
  return { ...report, pinned: report.anchor_json ? 1 : 0, shots: results.length, attachments: results }
}

/** The owner's side of a report: where it sits, what the reporter is told, and
 *  the owner's own notes. The reporter's words are never edited. */
export async function updateReport(
  db: D1Database,
  accountId: number,
  publicId: string,
  input: {
    state: ReportState
    status: ReportStatus
    priority: number | null
    title: string
    ownerNote: string | null
    now: number
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE reports SET state = ?, status = ?, priority = ?, title = ?, owner_note = ?, updated_at = ?
    WHERE account_id = ? AND public_id = ?`,
    )
    .bind(input.state, input.status, input.priority, input.title, input.ownerNote, input.now, accountId, publicId)
    .run()
  return result.meta.changes === 1
}

/** The R2 key for one image of one report, or null. Both ids must belong to the
 *  account: the key is never built from anything the request supplied. */
export function reportAttachment(
  db: D1Database,
  accountId: number,
  reportPublicId: string,
  attachmentPublicId: string,
) {
  return db
    .prepare(
      `SELECT a.object_key, a.mime, a.bytes FROM attachments a
    JOIN reports r ON r.account_id = a.account_id AND r.site_id = a.site_id AND r.id = a.report_id
    WHERE a.account_id = ? AND r.public_id = ? AND a.public_id = ?`,
    )
    .bind(accountId, reportPublicId, attachmentPublicId)
    .first<{ object_key: string; mime: string; bytes: number }>()
}

/** One report's pin, for an owner's view token. The page must match as well as
 *  the site: a token minted for one page shows nothing on another. Spam is never
 *  drawn on a host page. */
export async function viewedPin(
  db: D1Database,
  site: IngestSite,
  reportPublicId: string,
  pageKey: string,
): Promise<SavedPin | null> {
  const row = await db
    .prepare(
      `SELECT r.public_id AS id, r.kind, r.status, r.title, r.body, p.anchor_json
    FROM reports r JOIN pins p ON p.account_id = r.account_id AND p.site_id = r.site_id AND p.report_id = r.id
    WHERE r.account_id = ? AND r.site_id = ? AND r.public_id = ? AND r.page_key = ? AND r.state != 'spam'`,
    )
    .bind(site.account_id, site.id, reportPublicId, pageKey)
    .first<{ id: string; kind: string; status: string; title: string; body: string; anchor_json: string }>()
  if (!row) return null
  try {
    return parseSavedPin({ ...row, anchor: JSON.parse(row.anchor_json) })
  } catch {
    return null
  }
}
