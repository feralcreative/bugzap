-- Times are Unix seconds. Tenant keys travel with every dependent row so a
-- programming error cannot attach one account's data to another account's site.
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE memberships (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (account_id, user_id)
);

-- Only hashes of login and session tokens are ever stored.
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX login_tokens_expiry ON login_tokens(expires_at);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE sites (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,
  previous_secret_cipher TEXT,
  previous_secret_expires_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (account_id, id),
  CHECK ((previous_secret_cipher IS NULL) = (previous_secret_expires_at IS NULL))
);

CREATE TABLE site_origins (
  account_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  origin TEXT NOT NULL,
  PRIMARY KEY (site_id, origin),
  FOREIGN KEY (account_id, site_id) REFERENCES sites(account_id, id) ON DELETE CASCADE
);

CREATE TABLE reporters (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 128),
  email TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (site_id, subject),
  UNIQUE (account_id, site_id, id),
  FOREIGN KEY (account_id, site_id) REFERENCES sites(account_id, id) ON DELETE CASCADE
);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  reporter_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bug', 'idea', 'question')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'published', 'archived', 'spam')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'planned', 'in_progress', 'done', 'not_doing', 'no_repro')),
  title TEXT NOT NULL,
  -- SQLite counts codepoints; the parser counts UTF-16 units. The parser owns
  -- the minimum so a short valid report containing emoji is not rejected here.
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  priority INTEGER CHECK (priority BETWEEN 0 AND 3),
  owner_note TEXT,
  page_url TEXT NOT NULL,
  page_key TEXT NOT NULL,
  page_title TEXT,
  screenshot_mode TEXT NOT NULL CHECK (screenshot_mode IN ('auto', 'upload', 'none')),
  screenshot_failed TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (account_id, site_id, id),
  FOREIGN KEY (account_id, site_id) REFERENCES sites(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, site_id, reporter_id) REFERENCES reporters(account_id, site_id, id)
);
CREATE INDEX reports_inbox ON reports(account_id, site_id, state, created_at);
CREATE INDEX reports_page ON reports(site_id, page_key);
CREATE INDEX reports_hourly ON reports(site_id, reporter_id, created_at);

-- SUBMIT_LIMIT in core/policy.ts is 10. The handler checks cheaply before doing
-- image work; this guard repeats it inside the atomic batch to close the race.
CREATE TRIGGER reports_hourly_limit BEFORE INSERT ON reports
WHEN (SELECT count(*) FROM reports
      WHERE site_id = NEW.site_id AND reporter_id = NEW.reporter_id
      AND created_at > NEW.created_at - 3600) >= 10
BEGIN
  SELECT RAISE(ABORT, 'report_hourly_limit');
END;

CREATE TABLE pins (
  report_id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  anchor_json TEXT NOT NULL CHECK (json_valid(anchor_json)),
  FOREIGN KEY (account_id, site_id, report_id) REFERENCES reports(account_id, site_id, id) ON DELETE CASCADE
);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  report_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('screenshot', 'attachment')),
  object_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 2097152),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id, site_id, report_id) REFERENCES reports(account_id, site_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX attachments_screenshot ON attachments(report_id) WHERE role = 'screenshot';

CREATE TABLE diagnostics (
  report_id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  FOREIGN KEY (account_id, site_id, report_id) REFERENCES reports(account_id, site_id, id) ON DELETE CASCADE
);
