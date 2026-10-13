-- Odds poll presence proof (issue #26).
-- Content-hash dedupe on odds_snapshots means "unchanged" leaves no rows;
-- poll_ticks records that we polled each race, compacted to one row per minute
-- so D1 writes stay bounded while gaps >10 minutes remain detectable.
--
-- tick_minute: UTC minute bucket (…T12:34:00.000Z)
-- changed: 1 if any poll in that minute saw a new odds snapshot
-- last_tick_at: latest poll timestamp within the minute
-- tick_count: polls compacted into this minute

CREATE TABLE IF NOT EXISTS poll_ticks (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  tick_minute TEXT NOT NULL,
  changed INTEGER NOT NULL DEFAULT 0,
  last_tick_at TEXT NOT NULL,
  tick_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (meeting_date, venue, race_no, tick_minute)
);

CREATE INDEX IF NOT EXISTS idx_poll_ticks_race
  ON poll_ticks (meeting_date, venue, race_no, tick_minute);
