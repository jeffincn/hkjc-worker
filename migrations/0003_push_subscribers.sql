-- Multi-subscriber push targets. Secrets are never stored in git;
-- PUSH_SECRET is applied at runtime to the agent webhook when its row has no secret.

CREATE TABLE IF NOT EXISTS push_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subscribers_enabled
  ON push_subscribers (enabled);

-- Seed known receivers (URLs only; HMAC secret filled from PUSH_SECRET at runtime).
INSERT OR IGNORE INTO push_subscribers (url, secret, enabled, created_at, updated_at)
VALUES
  (
    'https://webhook.site/902a6166-6336-452d-97c5-e64018d97919',
    NULL,
    1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'https://hkjc-agent.cf-connect.top/webhook',
    NULL,
    1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );

-- Per-subscriber retry queue (nullable = legacy / PUSH_TARGET_URL fallback).
ALTER TABLE pending_pushes ADD COLUMN subscriber_id INTEGER;
