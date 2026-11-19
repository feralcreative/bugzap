-- Owners sign in with Google instead of an emailed link. A user is known by
-- Google's stable account id, not by an address that can be reassigned.
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;

DROP TABLE login_tokens;
