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
  is_standby INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS idx_runners_horse_code ON runners (horse_code);
CREATE INDEX IF NOT EXISTS idx_runners_lookup_code
  ON runners (meeting_date, venue, race_no, horse_no, is_standby);
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
  created_at TEXT NOT NULL,
  sample_interval_s REAL
);
CREATE INDEX IF NOT EXISTS idx_odds_created_at ON odds_snapshots (created_at);
CREATE TABLE IF NOT EXISTS results (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  horse_no INTEGER NOT NULL,
  horse_code TEXT,
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
  subscriber_id INTEGER,
  event_id TEXT
);
CREATE TABLE IF NOT EXISTS push_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  active_window TEXT NOT NULL DEFAULT 'always',
  window_before_sec INTEGER NOT NULL DEFAULT 10800,
  quiet_start TEXT,
  quiet_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_429s INTEGER NOT NULL DEFAULT 0,
  circuit_state TEXT NOT NULL DEFAULT 'closed',
  circuit_opened_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_http_status INTEGER,
  last_error TEXT
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
  last_rating TEXT,
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
CREATE TABLE IF NOT EXISTS push_seq (
  meeting_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 0,
  last_change_seq INTEGER,
  last_change_at TEXT,
  PRIMARY KEY (meeting_date, venue)
);
CREATE TABLE IF NOT EXISTS push_events (
  event_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  meeting_date TEXT,
  venue TEXT,
  event_type TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source_last_updated_at TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graphql_usage (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_events_meeting_seq
  ON push_events (meeting_date, venue, seq);
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
  sec1_json TEXT,
  sec2_json TEXT,
  sec3_json TEXT,
  sec4_json TEXT,
  sec5_json TEXT,
  sec6_json TEXT,
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
CREATE TABLE IF NOT EXISTS gear_changes (
  horse_code TEXT NOT NULL,
  race_date TEXT NOT NULL,
  race_index TEXT NOT NULL DEFAULT '',
  venue TEXT,
  race_no INTEGER,
  track TEXT,
  course TEXT,
  gear_raw TEXT,
  gear_items_json TEXT,
  data_source TEXT NOT NULL DEFAULT 'html_horse',
  source_url TEXT,
  content_hash TEXT,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (horse_code, race_date, race_index)
);
CREATE TABLE IF NOT EXISTS official_ratings (
  horse_code TEXT NOT NULL,
  race_date TEXT NOT NULL,
  race_index TEXT NOT NULL DEFAULT '',
  venue TEXT,
  race_no INTEGER,
  rating INTEGER,
  rating_change INTEGER,
  last_rating INTEGER,
  data_source TEXT NOT NULL DEFAULT 'html_horse',
  source_url TEXT,
  content_hash TEXT,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (horse_code, race_date, race_index)
);
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
