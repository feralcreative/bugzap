import type { Diagnostics } from '../../core/diagnostics'
import type { IdentityClaims } from '../../core/identity'
import type { ReportPayload } from '../../core/payload'
import { titleFrom } from '../../core/policy'
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
