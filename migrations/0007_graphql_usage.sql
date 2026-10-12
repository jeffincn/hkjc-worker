-- Per-HKT-day HKJC GraphQL request accounting (MeetingPoller flushes deltas).
CREATE TABLE IF NOT EXISTS graphql_usage (
  day TEXT PRIMARY KEY,          -- YYYY-MM-DD in Asia/Hong_Kong
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Effective poll interval (seconds) in force when each odds snapshot was captured.
ALTER TABLE odds_snapshots ADD COLUMN sample_interval_s REAL;
