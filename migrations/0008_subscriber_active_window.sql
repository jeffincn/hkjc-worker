-- Per-subscriber delivery window:
--   active_window = 'always'  → receive every push (default)
--   active_window = 'raceday' → only [first_post - window_before_sec, final dividends)
-- window_before_sec defaults to 10800 (3h before first race).

ALTER TABLE push_subscribers ADD COLUMN active_window TEXT NOT NULL DEFAULT 'always';
ALTER TABLE push_subscribers ADD COLUMN window_before_sec INTEGER NOT NULL DEFAULT 10800;

-- Manus (subscriber id 4): race-day window starting 3h before first post.
UPDATE push_subscribers
SET active_window = 'raceday',
    window_before_sec = 10800,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 4;
