-- Per-horse sectional times from HKJC displaysectionaltime (issue #46).
-- PK aligns with model sample: one row per (meeting, race, horse_code).
-- Migration number 0013: 0012 reserved by open PR #43 (runner standby key).

CREATE TABLE IF NOT EXISTS sectional_times (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  horse_code TEXT NOT NULL,
  horse_name TEXT,
  horse_no INTEGER,
  finishing_order INTEGER,
  finish_time TEXT,
  finish_time_sec REAL,
  race_info TEXT,
  -- Each secN_json: {"pos":INT,"margin":TEXT,"time":REAL} or NULL when blank
  sec1_json TEXT,
  sec2_json TEXT,
  sec3_json TEXT,
  sec4_json TEXT,
  sec5_json TEXT,
  sec6_json TEXT,
  -- Full segments incl. optional 200m splits on later sections:
  -- [{"idx":1,"pos":4,"margin":"5","time":23.57,"splits":null}, ...]
  segments_json TEXT,
  source_url TEXT,
  content_hash TEXT,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, horse_code)
);

CREATE INDEX IF NOT EXISTS idx_sectional_times_meeting
  ON sectional_times (meeting_date, venue, race_no);

CREATE INDEX IF NOT EXISTS idx_sectional_times_horse
  ON sectional_times (horse_code, meeting_date);

-- Resumable per-race ingest / backfill cursor (aligns with meetings/races rows).
CREATE TABLE IF NOT EXISTS sectional_ingest_progress (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT,
  source_url TEXT,
  scraped_at TEXT,
  error_message TEXT,
  PRIMARY KEY (meeting_date, venue, race_no)
);

CREATE INDEX IF NOT EXISTS idx_sectional_ingest_status
  ON sectional_ingest_progress (status, meeting_date);
