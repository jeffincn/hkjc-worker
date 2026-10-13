-- Odds poll presence proof (issue #26 / R1b).
-- Content-hash dedupe on odds_snapshots means "unchanged" leaves no rows;
-- poll_ticks records one row per poll tick per race so STATIC vs MISSING
-- (COLLECTION_FAILURE when gap > 10 min) is mechanically distinguishable.
--
-- C1: do NOT compact/merge rows — heartbeat write cost is negligible.
-- C2: odds_snapshots hash-dedup behavior unchanged.
-- C3: no TTL/retention on odds_snapshots.

CREATE TABLE IF NOT EXISTS poll_ticks (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  tick_time TEXT NOT NULL,
  changed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (meeting_date, venue, race_no, tick_time)
);

CREATE INDEX IF NOT EXISTS idx_poll_ticks_race
  ON poll_ticks (meeting_date, venue, race_no, tick_time);
