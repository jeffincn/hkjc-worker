-- Horse profiles, past runs, injuries + generic raw document store

CREATE TABLE IF NOT EXISTS horses (
  horse_code TEXT PRIMARY KEY,
  horse_id TEXT,
  name_en TEXT,
  name_ch TEXT,
  colour TEXT,
  sex TEXT,
  import_type TEXT,
  owner TEXT,
  sire TEXT,
  dam TEXT,
  dams_sire TEXT,
  total_stakes TEXT,
  season_stakes TEXT,
  current_rating TEXT,
  data_source TEXT NOT NULL DEFAULT 'html_horse',
  source_url TEXT,
  content_hash TEXT,
  raw_json TEXT,
  fetched_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS horse_past_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  horse_code TEXT NOT NULL,
  race_index TEXT,
  placing TEXT,
  race_date TEXT,
  venue TEXT,
  track TEXT,
  course TEXT,
  distance INTEGER,
  going TEXT,
  race_class TEXT,
  draw INTEGER,
  rating TEXT,
  trainer TEXT,
  jockey TEXT,
  lbw TEXT,
  win_odds REAL,
  actual_weight REAL,
  running_position TEXT,
  finish_time TEXT,
  declared_weight REAL,
  gear TEXT,
  data_source TEXT NOT NULL DEFAULT 'html_horse',
  source_url TEXT,
  content_hash TEXT,
  raw_json TEXT,
  fetched_at TEXT NOT NULL,
  UNIQUE (horse_code, race_index, race_date)
);

CREATE INDEX IF NOT EXISTS idx_horse_runs_code ON horse_past_runs (horse_code, race_date);

CREATE TABLE IF NOT EXISTS horse_injuries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  horse_code TEXT,
  horse_name TEXT,
  meeting_date TEXT,
  venue TEXT,
  record_date TEXT,
  details TEXT,
  passed_on TEXT,
  data_source TEXT NOT NULL DEFAULT 'html_vet',
  source_url TEXT,
  content_hash TEXT,
  raw_json TEXT,
  fetched_at TEXT NOT NULL,
  UNIQUE (horse_code, record_date, details)
);

CREATE INDEX IF NOT EXISTS idx_horse_injuries_code ON horse_injuries (horse_code, record_date);

-- Generic raw capture for any GraphQL/HTML document (record everything + hash)
CREATE TABLE IF NOT EXISTS raw_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  raw_json TEXT,
  changed INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT NOT NULL,
  UNIQUE (doc_type, doc_key, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_raw_docs_lookup ON raw_documents (doc_type, doc_key, fetched_at);

CREATE TABLE IF NOT EXISTS horse_fetch_state (
  horse_code TEXT PRIMARY KEY,
  meeting_date TEXT,
  venue TEXT,
  last_profile_hash TEXT,
  last_runs_hash TEXT,
  last_injury_hash TEXT,
  first_seen_at TEXT,
  last_fetched_at TEXT,
  race_day_refreshed INTEGER NOT NULL DEFAULT 0
);
