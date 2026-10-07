-- HKJC data worker schema

CREATE TABLE IF NOT EXISTS meetings (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  total_races INTEGER,
  status TEXT,
  data_source TEXT NOT NULL DEFAULT 'graphql',
  raw_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue)
);

CREATE TABLE IF NOT EXISTS races (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  post_time TEXT,
  status TEXT,
  distance INTEGER,
  going TEXT,
  course_desc TEXT,
  course_code TEXT,
  race_class TEXT,
  data_source TEXT NOT NULL DEFAULT 'graphql',
  raw_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no)
);

CREATE TABLE IF NOT EXISTS runners (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  horse_no INTEGER NOT NULL,
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
  PRIMARY KEY (meeting_date, venue, race_no, horse_no)
);

CREATE TABLE IF NOT EXISTS odds_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  snapshot_time TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  pool_status TEXT,
  raw_json TEXT NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'graphql',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_odds_lookup
  ON odds_snapshots (meeting_date, venue, race_no, snapshot_time);

CREATE INDEX IF NOT EXISTS idx_odds_hash
  ON odds_snapshots (meeting_date, venue, race_no, content_hash);

CREATE TABLE IF NOT EXISTS results (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  horse_no INTEGER NOT NULL,
  final_position INTEGER,
  dead_heat INTEGER,
  win_odds REAL,
  place_odds REAL,
  dividends_json TEXT,
  data_source TEXT NOT NULL DEFAULT 'graphql',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (meeting_date, venue, race_no, horse_no)
);

CREATE TABLE IF NOT EXISTS push_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  target_url TEXT,
  http_status INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  payload_hash TEXT,
  error_message TEXT,
  sent_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_sent_at ON push_log (sent_at);

CREATE TABLE IF NOT EXISTS change_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_date TEXT,
  venue TEXT,
  race_no INTEGER,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_changes_since ON change_events (created_at);

CREATE TABLE IF NOT EXISTS backfill_progress (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  status TEXT NOT NULL,
  data_source TEXT NOT NULL DEFAULT 'graphql',
  completed_at TEXT,
  error_message TEXT,
  PRIMARY KEY (meeting_date, venue)
);

CREATE TABLE IF NOT EXISTS worker_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_pushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  last_error TEXT
);
