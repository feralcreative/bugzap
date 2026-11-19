-- Who may report on a site. 'guest': anyone on an allowed origin, with nothing
-- for the host to set up beyond the embed. 'signed': only people the host's
-- server vouches for with a signed identity token.
ALTER TABLE sites ADD COLUMN identity_mode TEXT NOT NULL DEFAULT 'guest'
  CHECK (identity_mode IN ('guest', 'signed'));

-- Every site that exists already was created when a signed token was the only
-- way in. They stay that way until their owner chooses otherwise.
UPDATE sites SET identity_mode = 'signed';

-- GUEST_SITE_LIMIT in core/policy.ts is 100. A guest can throw their id away and
-- take a new one, so guests are also counted together, per site, per hour. The
-- handler checks cheaply first; this repeats it inside the atomic batch, as
-- reports_hourly_limit does for one reporter, so parallel requests cannot all
-- slip under the line.
CREATE INDEX reports_site_time ON reports(site_id, created_at);

CREATE TRIGGER reports_guest_site_limit BEFORE INSERT ON reports
WHEN (SELECT subject FROM reporters WHERE id = NEW.reporter_id) LIKE 'guest:%'
  AND (SELECT count(*) FROM reports r JOIN reporters p ON p.id = r.reporter_id
       WHERE r.site_id = NEW.site_id AND r.created_at > NEW.created_at - 3600
       AND p.subject LIKE 'guest:%') >= 100
BEGIN
  SELECT RAISE(ABORT, 'guest_site_limit');
END;
