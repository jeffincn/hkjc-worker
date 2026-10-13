-- Per-subscriber quiet hours (Asia/Hong_Kong wall clock, HH:MM).
-- NULL/NULL = no quiet hours. Overnight spans supported (e.g. 23:00–08:00).
-- Default for existing rows: 00:00–08:00 (Jeff: no pushes overnight).
-- EXCEPTION (code): in-progress meetings (final dividends not yet published)
-- keep receiving pushes through quiet hours until dividends land.

ALTER TABLE push_subscribers ADD COLUMN quiet_start TEXT;
ALTER TABLE push_subscribers ADD COLUMN quiet_end TEXT;

UPDATE push_subscribers
SET quiet_start = '00:00',
    quiet_end = '08:00',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE quiet_start IS NULL AND quiet_end IS NULL;
