-- hkjc-push/1.1: per-meeting monotonic seq + append-only event ledger

CREATE TABLE IF NOT EXISTS push_seq (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 0,
  last_change_seq INTEGER,
  last_change_at TEXT,
  PRIMARY KEY (meeting_date, venue)
);

CREATE TABLE IF NOT EXISTS push_events (
  event_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  meeting_date TEXT,
  venue TEXT,
  event_type TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source_last_updated_at TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_events_meeting_seq
  ON push_events (meeting_date, venue, seq);

CREATE INDEX IF NOT EXISTS idx_push_events_created_at
  ON push_events (created_at);

-- Prefer reloading immutable body from push_events on retry when set.
ALTER TABLE pending_pushes ADD COLUMN event_id TEXT;
