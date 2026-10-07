import type { NormalizedMeeting, NormalizedRace, NormalizedRunner } from "../parse/meeting";
import type { RaceOddsSnapshot } from "../parse/odds";
import { contentHash } from "../parse/hash";
import type { ChangeHistoryRaw, PmPoolRaw } from "../graphql/types";

export async function upsertMeeting(
  db: D1Database,
  meeting: NormalizedMeeting,
  rawJson?: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meetings (meeting_date, venue, total_races, status, data_source, raw_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(meeting_date, venue) DO UPDATE SET
         total_races=excluded.total_races,
         status=excluded.status,
         data_source=excluded.data_source,
         raw_json=excluded.raw_json,
         updated_at=excluded.updated_at`,
    )
    .bind(
      meeting.meeting_date,
      meeting.venue,
      meeting.total_races,
      meeting.status,
      meeting.data_source,
      rawJson ? JSON.stringify(rawJson) : null,
      new Date().toISOString(),
    )
    .run();
}

export async function upsertRace(
  db: D1Database,
  meetingDate: string,
  venue: string,
  race: NormalizedRace,
  dataSource: string,
  rawJson?: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO races (meeting_date, venue, race_no, post_time, status, distance, going, course_desc, course_code, race_class, data_source, raw_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(meeting_date, venue, race_no) DO UPDATE SET
         post_time=excluded.post_time,
         status=excluded.status,
         distance=COALESCE(excluded.distance, races.distance),
         going=COALESCE(excluded.going, races.going),
         course_desc=COALESCE(excluded.course_desc, races.course_desc),
         course_code=COALESCE(excluded.course_code, races.course_code),
         race_class=COALESCE(excluded.race_class, races.race_class),
         data_source=excluded.data_source,
         raw_json=COALESCE(excluded.raw_json, races.raw_json),
         updated_at=excluded.updated_at`,
    )
    .bind(
      meetingDate,
      venue,
      race.race_no,
      race.post_time,
      race.status,
      race.distance,
      race.going,
      race.course_desc,
      race.course_code,
      race.race_class,
      dataSource,
      rawJson ? JSON.stringify(rawJson) : null,
      new Date().toISOString(),
    )
    .run();
}

export async function upsertRunner(
  db: D1Database,
  meetingDate: string,
  venue: string,
  raceNo: number,
  runner: NormalizedRunner,
  dataSource: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runners (meeting_date, venue, race_no, horse_no, name_en, name_ch, status, barrier, handicap_weight, jockey_en, trainer_en, last6run, data_source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(meeting_date, venue, race_no, horse_no) DO UPDATE SET
         name_en=COALESCE(excluded.name_en, runners.name_en),
         name_ch=COALESCE(excluded.name_ch, runners.name_ch),
         status=COALESCE(excluded.status, runners.status),
         barrier=COALESCE(excluded.barrier, runners.barrier),
         handicap_weight=COALESCE(excluded.handicap_weight, runners.handicap_weight),
         jockey_en=COALESCE(excluded.jockey_en, runners.jockey_en),
         trainer_en=COALESCE(excluded.trainer_en, runners.trainer_en),
         last6run=COALESCE(excluded.last6run, runners.last6run),
         data_source=excluded.data_source,
         updated_at=excluded.updated_at`,
    )
    .bind(
      meetingDate,
      venue,
      raceNo,
      runner.horse_no,
      runner.name_en,
      runner.name_ch,
      runner.status,
      runner.barrier,
      runner.handicap_weight,
      runner.jockey_en,
      runner.trainer_en,
      runner.last6run,
      dataSource,
      new Date().toISOString(),
    )
    .run();
}

export async function upsertResult(
  db: D1Database,
  meetingDate: string,
  venue: string,
  raceNo: number,
  runner: NormalizedRunner,
  dataSource: string,
  placeOdds: number | null = null,
  dividendsJson: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO results (meeting_date, venue, race_no, horse_no, final_position, dead_heat, win_odds, place_odds, dividends_json, data_source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(meeting_date, venue, race_no, horse_no) DO UPDATE SET
         final_position=COALESCE(excluded.final_position, results.final_position),
         dead_heat=COALESCE(excluded.dead_heat, results.dead_heat),
         win_odds=COALESCE(excluded.win_odds, results.win_odds),
         place_odds=COALESCE(excluded.place_odds, results.place_odds),
         dividends_json=COALESCE(excluded.dividends_json, results.dividends_json),
         data_source=excluded.data_source,
         updated_at=excluded.updated_at`,
    )
    .bind(
      meetingDate,
      venue,
      raceNo,
      runner.horse_no,
      runner.final_position,
      runner.dead_heat == null ? null : runner.dead_heat ? 1 : 0,
      runner.win_odds,
      placeOdds,
      dividendsJson,
      dataSource,
      new Date().toISOString(),
    )
    .run();
}

export interface SnapshotInsertResult {
  inserted: boolean;
  content_hash: string;
  snapshot_time: string;
}

export async function insertOddsSnapshotIfChanged(
  db: D1Database,
  meetingDate: string,
  venue: string,
  snapshot: RaceOddsSnapshot,
  dataSource = "graphql",
): Promise<SnapshotInsertResult> {
  const hash = await contentHash(snapshot.payload);
  const existing = await db
    .prepare(
      `SELECT content_hash FROM odds_snapshots
       WHERE meeting_date=? AND venue=? AND race_no=?
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(meetingDate, venue, snapshot.race_no)
    .first<{ content_hash: string }>();

  if (existing?.content_hash === hash) {
    return { inserted: false, content_hash: hash, snapshot_time: snapshot.snapshot_time };
  }

  await db
    .prepare(
      `INSERT INTO odds_snapshots (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      meetingDate,
      venue,
      snapshot.race_no,
      snapshot.snapshot_time,
      hash,
      snapshot.pool_status,
      JSON.stringify(snapshot),
      dataSource,
      new Date().toISOString(),
    )
    .run();

  return { inserted: true, content_hash: hash, snapshot_time: snapshot.snapshot_time };
}

export async function persistMeetingTree(
  db: D1Database,
  meeting: NormalizedMeeting,
  raw?: unknown,
): Promise<void> {
  await upsertMeeting(db, meeting, raw);
  for (const race of meeting.races) {
    await upsertRace(db, meeting.meeting_date, meeting.venue, race, meeting.data_source);
    for (const runner of race.runners) {
      await upsertRunner(
        db,
        meeting.meeting_date,
        meeting.venue,
        race.race_no,
        runner,
        meeting.data_source,
      );
      if (runner.final_position != null || runner.win_odds != null) {
        await upsertResult(
          db,
          meeting.meeting_date,
          meeting.venue,
          race.race_no,
          runner,
          meeting.data_source,
        );
      }
    }
  }
}

export async function storeChangeHistories(
  db: D1Database,
  meetingDate: string,
  venue: string,
  changes: ChangeHistoryRaw[],
): Promise<number> {
  let n = 0;
  for (const ch of changes) {
    const payload = JSON.stringify(ch);
    const hash = await contentHash(ch);
    const dup = await db
      .prepare(
        `SELECT id FROM change_events WHERE content_hash=? AND meeting_date=? AND venue=? LIMIT 1`,
      )
      .bind(hash, meetingDate, venue)
      .first();
    if (dup) continue;
    await db
      .prepare(
        `INSERT INTO change_events (meeting_date, venue, race_no, event_type, payload_json, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        meetingDate,
        venue,
        ch.raceNo ?? null,
        ch.type ?? "change",
        payload,
        hash,
        ch.time ?? new Date().toISOString(),
      )
      .run();
    n++;
  }
  return n;
}

export async function storeDividendsAsResults(
  db: D1Database,
  meetingDate: string,
  venue: string,
  raceNo: number,
  pools: PmPoolRaw[],
  dataSource: string,
): Promise<void> {
  const json = JSON.stringify(pools);
  // Ensure at least a placeholder result row keyed by horse from WIN dividends if no runners
  const winPool = pools.find((p) => p.oddsType === "WIN");
  for (const d of winPool?.dividends ?? []) {
    const horseNo = Number(d.winComb);
    if (!Number.isFinite(horseNo)) continue;
    await db
      .prepare(
        `INSERT INTO results (meeting_date, venue, race_no, horse_no, final_position, dead_heat, win_odds, place_odds, dividends_json, data_source, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
         ON CONFLICT(meeting_date, venue, race_no, horse_no) DO UPDATE SET
           dividends_json=excluded.dividends_json,
           data_source=excluded.data_source,
           updated_at=excluded.updated_at`,
      )
      .bind(meetingDate, venue, raceNo, horseNo, json, dataSource, new Date().toISOString())
      .run();
  }
  // Also attach dividends_json onto existing result rows for this race
  await db
    .prepare(
      `UPDATE results SET dividends_json=?, updated_at=? WHERE meeting_date=? AND venue=? AND race_no=?`,
    )
    .bind(json, new Date().toISOString(), meetingDate, venue, raceNo)
    .run();
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO worker_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    )
    .bind(key, value, new Date().toISOString())
    .run();
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM worker_meta WHERE key=?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function markBackfillDone(
  db: D1Database,
  meetingDate: string,
  venue: string,
  dataSource: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO backfill_progress (meeting_date, venue, status, data_source, completed_at, error_message)
       VALUES (?, ?, 'done', ?, ?, NULL)
       ON CONFLICT(meeting_date, venue) DO UPDATE SET
         status='done', data_source=excluded.data_source, completed_at=excluded.completed_at, error_message=NULL`,
    )
    .bind(meetingDate, venue, dataSource, new Date().toISOString())
    .run();
}

export async function isBackfillDone(
  db: D1Database,
  meetingDate: string,
  venue: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT status FROM backfill_progress WHERE meeting_date=? AND venue=?`)
    .bind(meetingDate, venue)
    .first<{ status: string }>();
  return row?.status === "done";
}
