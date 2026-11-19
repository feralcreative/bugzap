// Sign-in state: users and sessions. None of it is tenant data, so it lives
// outside scoped.ts; the session lookup is what yields the account id that every
// scoped query then carries.

export const SESSION_TTL_S = 30 * 24 * 60 * 60

export type SessionUser = { userId: number; email: string; accountId: number; accountName: string }

/**
 * Opens a session for a person Google has just vouched for, creating the user
 * and their account on first sign-in. Returns false when the address already
 * belongs to a different Google identity: an address reassigned to someone new
 * must not inherit the previous holder's account.
 *
 * A user is matched by Google's stable id first. Matching by address happens
 * only for a row that has never been tied to an identity (the locally seeded
 * owner, or anything from before Google sign-in), and ties it.
 */
export async function openGoogleSession(
  db: D1Database,
  input: {
    sub: string
    email: string
    name: string | null
    sessionHash: string
    accountPublicId: string
    now: number
  },
): Promise<boolean> {
  const { sub, email, name, sessionHash, accountPublicId, now } = input
  const known = await db.prepare('SELECT id FROM users WHERE google_sub = ?').bind(sub).first<{ id: number }>()
  const identify = known
    ? // The address may have changed at Google. Follow it unless another user has it.
      db
        .prepare(
          `UPDATE users SET email = ?1 WHERE id = ?2
        AND NOT EXISTS (SELECT 1 FROM users o WHERE o.email = ?1 AND o.id != ?2)`,
        )
        .bind(email, known.id)
    : db
        .prepare(
          `INSERT INTO users (email, name, google_sub, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (email) DO UPDATE SET google_sub = excluded.google_sub, name = coalesce(users.name, excluded.name)
        WHERE users.google_sub IS NULL`,
        )
        .bind(email, name, sub, now)
  // One batch, so two first sign-ins at once cannot create two accounts. Every
  // later statement finds the user by `sub`: if the address was already tied to
  // another identity, the statement above changed nothing and these find no one.
  const results = await db.batch([
    identify,
    db
      .prepare(
        `INSERT INTO accounts (public_id, name)
      SELECT ?, substr(u.email, 1, instr(u.email, '@') - 1) FROM users u
      WHERE u.google_sub = ? AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)`,
      )
      .bind(accountPublicId, sub),
    db
      .prepare(
        `INSERT INTO memberships (account_id, user_id)
      SELECT a.id, u.id FROM accounts a, users u WHERE a.public_id = ? AND u.google_sub = ?`,
      )
      .bind(accountPublicId, sub),
    db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
      SELECT ?, u.id, ?, ? FROM users u WHERE u.google_sub = ?`,
      )
      .bind(sessionHash, now + SESSION_TTL_S, now, sub),
  ])
  return (results[3]?.meta.changes ?? 0) === 1
}

/** The signed-in user and the one account they own. v1 gives each user a single
 *  account; the lowest id keeps the choice stable if that ever changes. Only an
 *  owner gets in: the dashboard's every screen manages keys and secrets, and no
 *  screen is yet scoped to what a `member` may do. */
export function findSession(db: D1Database, sessionHash: string, now: number): Promise<SessionUser | null> {
  return db
    .prepare(
      `SELECT u.id AS userId, u.email, a.id AS accountId, a.name AS accountName
    FROM sessions s JOIN users u ON u.id = s.user_id
    JOIN memberships m ON m.user_id = u.id JOIN accounts a ON a.id = m.account_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND m.role = 'owner' ORDER BY a.id LIMIT 1`,
    )
    .bind(sessionHash, now)
    .first<SessionUser>()
}

/** Ends every session of the person with this Google id, if there is one. */
export async function endSessionsFor(db: D1Database, sub: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE google_sub = ?)').bind(sub).run()
}

export async function deleteSession(db: D1Database, sessionHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(sessionHash).run()
}
