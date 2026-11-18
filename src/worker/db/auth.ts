// Sign-in state: users, login tokens, and sessions. None of it is tenant data, so
// it lives outside scoped.ts; the session lookup is what yields the account id that
// every scoped query then carries.

export const LOGIN_TOKEN_TTL_S = 15 * 60
export const SESSION_TTL_S = 30 * 24 * 60 * 60
/** Unconsumed links one address may hold at once. The rate-limit binding is
 *  eventually consistent across locations; this count is not. */
export const LOGIN_TOKENS_MAX = 5

export type SessionUser = { userId: number; email: string; accountId: number; accountName: string }

/**
 * Stores a login token for an allowlisted address. Returns false when the address
 * already holds too many live links. Only a bare user row is created here; the
 * account waits until the link is used, so asking for links to addresses nobody
 * controls cannot fill the database with tenants.
 */
export async function createLoginToken(
  db: D1Database,
  input: { email: string; tokenHash: string; now: number },
): Promise<boolean> {
  const { email, tokenHash, now } = input
  const results = await db.batch([
    db.prepare('INSERT INTO users (email) VALUES (?) ON CONFLICT (email) DO NOTHING').bind(email),
    db
      .prepare('DELETE FROM login_tokens WHERE user_id = (SELECT id FROM users WHERE email = ?) AND expires_at <= ?')
      .bind(email, now),
    db
      .prepare(
        `INSERT INTO login_tokens (token_hash, user_id, expires_at, created_at)
      SELECT ?, u.id, ?, ? FROM users u WHERE u.email = ? AND
      (SELECT count(*) FROM login_tokens t WHERE t.user_id = u.id AND t.consumed_at IS NULL) < ?`,
      )
      .bind(tokenHash, now + LOGIN_TOKEN_TTL_S, now, email, LOGIN_TOKENS_MAX),
  ])
  return (results[2]?.meta.changes ?? 0) === 1
}

/** True while the token could still be consumed. Reading it changes nothing, so
 *  an email scanner following the link does not burn it. */
export async function loginTokenIsLive(db: D1Database, tokenHash: string, now: number): Promise<boolean> {
  return !!(await db
    .prepare('SELECT 1 FROM login_tokens WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?')
    .bind(tokenHash, now)
    .first())
}

/**
 * Consumes a login token and opens a session. The UPDATE is the single-use gate:
 * only one request can flip `consumed_at`, so a token that was already used,
 * expired, or never existed opens nothing. The first successful sign-in also
 * creates the user's account, in the same batch as the session, so two links used
 * at once cannot create two accounts. If that batch fails the token stays spent
 * and the owner asks for a new link, which is the safe way round.
 */
export async function consumeLoginToken(
  db: D1Database,
  input: { tokenHash: string; sessionHash: string; accountPublicId: string; now: number },
): Promise<boolean> {
  const { tokenHash, sessionHash, accountPublicId, now } = input
  const used = await db
    .prepare(
      `UPDATE login_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
    RETURNING user_id`,
    )
    .bind(now, tokenHash, now)
    .first<{ user_id: number }>()
  if (!used) return false
  await db.batch([
    db
      .prepare(
        `INSERT INTO accounts (public_id, name)
      SELECT ?, substr(u.email, 1, instr(u.email, '@') - 1) FROM users u
      WHERE u.id = ? AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)`,
      )
      .bind(accountPublicId, used.user_id),
    // Selects nothing when the user already had an account and none was made above.
    db
      .prepare('INSERT INTO memberships (account_id, user_id) SELECT id, ? FROM accounts WHERE public_id = ?')
      .bind(used.user_id, accountPublicId),
    db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(sessionHash, used.user_id, now + SESSION_TTL_S, now),
  ])
  return true
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

export async function deleteSession(db: D1Database, sessionHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(sessionHash).run()
}
