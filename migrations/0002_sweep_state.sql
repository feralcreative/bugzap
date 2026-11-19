-- Where the hourly sweep left off in the screenshot bucket, so a bucket larger
-- than one run's budget is still covered completely over several runs.
CREATE TABLE sweep_state (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
