-- Per-subscriber circuit breaker + delivery health (never auto-delete subscribers).

ALTER TABLE push_subscribers ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscribers ADD COLUMN consecutive_429s INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscribers ADD COLUMN circuit_state TEXT NOT NULL DEFAULT 'closed';
ALTER TABLE push_subscribers ADD COLUMN circuit_opened_at TEXT;
ALTER TABLE push_subscribers ADD COLUMN last_success_at TEXT;
ALTER TABLE push_subscribers ADD COLUMN last_failure_at TEXT;
ALTER TABLE push_subscribers ADD COLUMN last_http_status INTEGER;
ALTER TABLE push_subscribers ADD COLUMN last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_push_subscribers_circuit
  ON push_subscribers (circuit_state);
