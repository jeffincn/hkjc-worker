-- Distinguishes Declared vs Standby when they share a cloth number (standbyNo).
-- Old PK (meeting_date, venue, race_no, horse_no) let standby upsert overwrite declared.
-- New PK adds is_standby; standby_no stores GraphQL standbyNo when present.
--
-- Historical polluted rows (standby fields already written onto the sole cloth
-- row) cannot be recovered here — re-ingest / raw backfill required (see PR).

CREATE TABLE runners_new (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  horse_no INTEGER NOT NULL,
  -- 0 = Declared (or non-standby); 1 = Standby reserve. Part of PK.
  is_standby INTEGER NOT NULL DEFAULT 0,
  -- GraphQL standbyNo when known; null for pure declared.
  standby_no INTEGER,
  horse_code TEXT,
  name_en TEXT,
  name_ch TEXT,
  status TEXT,
  barrier INTEGER,
  handicap_weight REAL,
  jockey_en TEXT,
  trainer_en TEXT,
  last6run TEXT,
  data_source TEXT NOT NULL DEFAULT 'graphql',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, horse_no, is_standby)
);

INSERT INTO runners_new (
  meeting_date, venue, race_no, horse_no, is_standby, standby_no,
  horse_code, name_en, name_ch, status, barrier, handicap_weight,
  jockey_en, trainer_en, last6run, data_source, updated_at
)
SELECT
  meeting_date,
  venue,
  race_no,
  horse_no,
  CASE
    WHEN UPPER(COALESCE(status, '')) LIKE '%STANDBY%' THEN 1
    ELSE 0
  END,
  CASE
    WHEN UPPER(COALESCE(status, '')) LIKE '%STANDBY%' THEN horse_no
    ELSE NULL
  END,
  horse_code,
  name_en,
  name_ch,
  status,
  barrier,
  handicap_weight,
  jockey_en,
  trainer_en,
  last6run,
  data_source,
  updated_at
FROM runners;

DROP TABLE runners;
ALTER TABLE runners_new RENAME TO runners;

CREATE INDEX IF NOT EXISTS idx_runners_horse_code ON runners (horse_code);
CREATE INDEX IF NOT EXISTS idx_runners_lookup_code
  ON runners (meeting_date, venue, race_no, horse_no, is_standby);
