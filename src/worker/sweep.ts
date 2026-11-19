// The hourly sweep. Each step is independent and bounded (SWEEP_ROWS rows or
// SWEEP_OBJECTS objects per run, the rest next hour), and a failure in one is
// logged and does not stop the others: this runs unattended.

/** Objects younger than this are left alone: an ingest writes its images to R2
 *  before the database row that claims them, so a new object is not an orphan yet. */
export const ORPHAN_AGE_S = 24 * 60 * 60
/** Bucket objects examined per run. The cursor carries on from here next hour. */
export const SWEEP_OBJECTS = 1000
/** Rows one statement may delete, so no run can outgrow D1's time limit. */
export const SWEEP_ROWS = 2000
const CURSOR = 'shots_cursor'
/** D1 allows 100 bound parameters per statement. */
const CHUNK = 90

type Counts = Record<string, number>

async function step(name: string, counts: Counts, run: () => Promise<number>) {
  try {
    counts[name] = await run()
  } catch {
    counts[name] = -1
    console.error(JSON.stringify({ event: 'sweep_step_failed', step: name }))
  }
}

const changes = (result: D1Result) => result.meta.changes ?? 0

/** Deletes bucket objects no attachment row claims. An object exists without a
 *  row only when an ingest stored its images and then could not confirm whether
 *  the report committed, and chose to leave them rather than risk deleting a
 *  saved report's screenshot. */
async function sweepOrphans(env: Pick<Env, 'DB' | 'SHOTS'>, now: number): Promise<number> {
  const saved = await env.DB.prepare('SELECT value FROM sweep_state WHERE name = ?')
    .bind(CURSOR)
    .first<{ value: string }>()
  const listing = await env.SHOTS.list({ limit: SWEEP_OBJECTS, startAfter: saved?.value || undefined })
  const old = listing.objects.filter((o) => o.uploaded.getTime() / 1000 < now - ORPHAN_AGE_S).map((o) => o.key)
  const claimed = new Set<string>()
  for (let i = 0; i < old.length; i += CHUNK) {
    const keys = old.slice(i, i + CHUNK)
    const { results } = await env.DB.prepare(
      `SELECT object_key FROM attachments WHERE object_key IN (${keys.map(() => '?').join(', ')})`,
    )
      .bind(...keys)
      .all<{ object_key: string }>()
    for (const row of results) claimed.add(row.object_key)
  }
  const orphans = old.filter((key) => !claimed.has(key))
  if (orphans.length) await env.SHOTS.delete(orphans)
  // At the end of the bucket the cursor resets, and the next run starts over.
  const next = listing.truncated ? (listing.objects.at(-1)?.key ?? '') : ''
  await env.DB.prepare(
    `INSERT INTO sweep_state (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(CURSOR, next, now)
    .run()
  return orphans.length
}

export async function sweep(env: Pick<Env, 'DB' | 'SHOTS'>, now: number): Promise<Counts> {
  const counts: Counts = {}
  const run =
    (sql: string, ...binds: unknown[]) =>
    async () =>
      changes(
        await env.DB.prepare(sql)
          .bind(...binds)
          .run(),
      )
  await step(
    'sessions',
    counts,
    run(
      'DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at <= ? LIMIT ?)',
      now,
      SWEEP_ROWS,
    ),
  )
  // A rotated-out secret stops verifying at its expiry; this removes the ciphertext too.
  await step(
    'previous_secrets',
    counts,
    run(
      `UPDATE sites SET previous_secret_cipher = NULL, previous_secret_expires_at = NULL
      WHERE previous_secret_expires_at <= ?`,
      now,
    ),
  )
  await step('orphan_images', counts, () => sweepOrphans(env, now))
  console.log(JSON.stringify({ event: 'sweep', ...counts }))
  return counts
}
