import { env } from "cloudflare:test";
import { beforeAll } from "vitest";

const MIGRATION_SQL = `
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
  last_error TEXT,
  subscriber_id INTEGER
);
CREATE TABLE IF NOT EXISTS push_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
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
`;

beforeAll(async () => {
  // D1 exec may not support multiple statements; split.
  const statements = MIGRATION_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) {
    await env.DB.prepare(sql).run();
  }
});
