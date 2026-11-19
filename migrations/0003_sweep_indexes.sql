-- The sweep asks, per user, whether any membership, login token, or session
-- remains. Without these each of those questions is a table scan.
CREATE INDEX memberships_user ON memberships(user_id);
CREATE INDEX login_tokens_user ON login_tokens(user_id);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX users_created ON users(created_at);
