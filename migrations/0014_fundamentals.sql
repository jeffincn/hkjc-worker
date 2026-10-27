-- Issue #50: gear changes, official ratings, barrier trials,
-- declared horse weights, rail position codes (+ Q/QP pool turnover only).

CREATE TABLE IF NOT EXISTS gear_changes (
  horse_code TEXT NOT NULL,
  race_date TEXT NOT NULL,
  race_index TEXT NOT NULL DEFAULT '',
  venue TEXT,
  race_no INTEGER,
  track TEXT,
  course TEXT,
  gear_raw TEXT,
  -- JSON: [{"code":"CP","action":"-"},{"code":"B","action":"1"}]
  gear_items_json TEXT,
  data_source TEXT NOT NULL DEFAULT 'html_horse',
  source_url TEXT,
  content_hash TEXT,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (horse_code, race_date, race_index)
);

CREATE INDEX IF NOT EXISTS idx_gear_changes_date
  ON gear_changes (race_date, venue, race_no);

CREATE INDEX IF NOT EXISTS idx_gear_changes_horse
  ON gear_changes (horse_code, race_date);

CREATE TABLE IF NOT EXISTS official_ratings (
  horse_code TEXT NOT NULL,
  race_date TEXT NOT NULL,
  race_index TEXT NOT NULL DEFAULT '',
  venue TEXT,
  race_no INTEGER,
  rating INTEGER,
  -- Diff vs previous race rating when both known (positive = up).
  rating_change INTEGER,
  last_rating INTEGER,
  data_source TEXT NOT NULL DEFAULT 'html_horse',
  source_url TEXT,
  content_hash TEXT,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (horse_code, race_date, race_index)
);

CREATE INDEX IF NOT EXISTS idx_official_ratings_horse
  ON official_ratings (horse_code, race_date);

CREATE TABLE IF NOT EXISTS barrier_trials (
  trial_date TEXT NOT NULL,
  batch_no INTEGER NOT NULL,
  horse_code TEXT NOT NULL,
  horse_name TEXT,
  venue TEXT,
  track TEXT,
  distance INTEGER,
  going TEXT,
  batch_time TEXT,
  sectional_times TEXT,
  jockey TEXT,
  trainer TEXT,
  draw INTEGER,
  gear TEXT,
  lbw TEXT,
  running_position TEXT,
  finish_time TEXT,
  result TEXT,
  comment TEXT,
  data_source TEXT NOT NULL DEFAULT 'html_btresult',
  source_url TEXT,
  content_hash TEXT,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (trial_date, batch_no, horse_code)
);

CREATE INDEX IF NOT EXISTS idx_barrier_trials_horse
  ON barrier_trials (horse_code, trial_date);

CREATE INDEX IF NOT EXISTS idx_barrier_trials_date
  ON barrier_trials (trial_date, batch_no);

CREATE TABLE IF NOT EXISTS barrier_trial_ingest_progress (
  trial_date TEXT NOT NULL PRIMARY KEY,
  status TEXT NOT NULL,
  content_hash TEXT,
  source_url TEXT,
  scraped_at TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS declared_horse_weights (
  horse_code TEXT NOT NULL,
  race_date TEXT NOT NULL,
  race_index TEXT NOT NULL DEFAULT '',
  venue TEXT,
  race_no INTEGER,
  declared_weight REAL,
  weight_date TEXT,
  data_source TEXT NOT NULL DEFAULT 'html_horse',
  source_url TEXT,
  content_hash TEXT,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (horse_code, race_date, race_index)
);

CREATE INDEX IF NOT EXISTS idx_declared_weights_horse
  ON declared_horse_weights (horse_code, race_date);

CREATE INDEX IF NOT EXISTS idx_declared_weights_date
  ON declared_horse_weights (race_date, venue);

-- Meeting-level rail / course codes (A / B / C / C+3 / …).
-- ST Mixed days may have Turf + AWT rows (track differentiates).
CREATE TABLE IF NOT EXISTS rail_positions (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  track TEXT NOT NULL DEFAULT '',
  course_code TEXT,
  course_desc TEXT,
  data_source TEXT NOT NULL DEFAULT 'graphql',
  source_url TEXT,
  content_hash TEXT,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, track)
);

CREATE INDEX IF NOT EXISTS idx_rail_positions_date
  ON rail_positions (meeting_date, venue);

-- Q/QP: pool size + turnover only (per-combination odds cells are JS-only).
CREATE TABLE IF NOT EXISTS quinella_pool_stats (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  pool_type TEXT NOT NULL,
  investment REAL,
  status TEXT,
  sell_status TEXT,
  last_update_time TEXT,
  data_source TEXT NOT NULL DEFAULT 'graphql',
  content_hash TEXT,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, pool_type)
);

CREATE INDEX IF NOT EXISTS idx_quinella_pool_meeting
  ON quinella_pool_stats (meeting_date, venue, race_no);

-- Profile-level Last Rating (horse page).
ALTER TABLE horses ADD COLUMN last_rating TEXT;
