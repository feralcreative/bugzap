import type { Diagnostics } from '../../core/diagnostics'
import type { IdentityClaims } from '../../core/identity'
import type { ReportPayload } from '../../core/payload'
import { ORIGINS_MAX, SITES_MAX, titleFrom } from '../../core/policy'
import { parseSavedPin, PINS_MAX, type SavedPin } from '../../core/pins'

export type IngestSite = {
  id: number
  account_id: number
  public_key: string
  secret_cipher: string
  previous_secret_cipher: string | null
  previous_secret_expires_at: number | null
  enabled: number
}

// The public key selects a site, never an account supplied by the reporter. After
// this lookup all reads and writes carry this server-loaded tenant scope.
export function findIngestSite(db: D1Database, publicKey: string): Promise<IngestSite | null> {
  return db
    .prepare(
      `SELECT id, account_id, public_key, secret_cipher,
    previous_secret_cipher, previous_secret_expires_at, enabled FROM sites WHERE public_key = ?`,
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
    claims: IdentityClaims
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
}

export function accountSites(db: D1Database, accountId: number): Promise<(AccountSite & { origins: number })[]> {
  return db
    .prepare(
      `SELECT s.id, s.public_key, s.name, s.enabled, s.created_at, s.previous_secret_expires_at,
      (SELECT count(*) FROM site_origins o WHERE o.account_id = s.account_id AND o.site_id = s.id) AS origins
    FROM sites s WHERE s.account_id = ? ORDER BY s.id`,
    )
    .bind(accountId)
    .all<AccountSite & { origins: number }>()
    .then((r) => r.results)
}

export async function accountSite(
  db: D1Database,
  accountId: number,
  publicKey: string,
): Promise<(AccountSite & { origins: string[] }) | null> {
  const site = await db
    .prepare(
      `SELECT id, public_key, name, enabled, created_at, previous_secret_expires_at
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
  input: { publicKey: string; name: string; secretCipher: string; origins: string[]; now: number },
): Promise<boolean> {
  const { publicKey, name, secretCipher, origins, now } = input
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO sites (account_id, public_key, name, secret_cipher, created_at)
      SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM sites WHERE account_id = ?) < ?`,
      )
      .bind(accountId, publicKey, name, secretCipher, now, accountId, SITES_MAX),
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
    .prepare('SELECT secret_cipher FROM sites WHERE account_id = ? AND public_key = ?')
    .bind(accountId, publicKey)
    .first<{ secret_cipher: string }>()
  if (!current) return false
  const result = await db
    .prepare(
      `UPDATE sites SET previous_secret_cipher = secret_cipher, previous_secret_expires_at = ?, secret_cipher = ?
    WHERE account_id = ? AND public_key = ? AND secret_cipher = ?`,
    )
    .bind(input.graceUntil, input.secretCipher, accountId, publicKey, current.secret_cipher)
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
