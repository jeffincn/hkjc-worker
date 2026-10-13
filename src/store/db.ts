import type { Env } from "../env";
import type { NormalizedMeeting, NormalizedRace, NormalizedRunner } from "../parse/meeting";
import { normalizeHorseCode } from "../parse/horse-code";
import {
  normalizeStoredSnapshot,
  type RaceOddsSnapshot,
} from "../parse/odds";
import { contentHash } from "../parse/hash";
import type { ChangeHistoryRaw, PmPoolRaw } from "../graphql/types";
import { trackD1Result } from "./d1-budget";

/** Payload used to detect meeting-tree changes (excludes change_histories). */
export function meetingTreeHashPayload(meeting: NormalizedMeeting): unknown {
  return {
    meeting_date: meeting.meeting_date,
    venue: meeting.venue,
    total_races: meeting.total_races,
    status: meeting.status,
    data_source: meeting.data_source,
    races: meeting.races,
  };
}

export async function meetingTreeContentHash(meeting: NormalizedMeeting): Promise<string> {
  return contentHash(meetingTreeHashPayload(meeting));
}

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
         updated_at=excluded.updated_at
       WHERE meetings.total_races IS DISTINCT FROM excluded.total_races
          OR meetings.status IS DISTINCT FROM excluded.status
          OR meetings.data_source IS DISTINCT FROM excluded.data_source
          OR meetings.raw_json IS DISTINCT FROM excluded.raw_json`,
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
         updated_at=excluded.updated_at
       WHERE races.post_time IS DISTINCT FROM excluded.post_time
          OR races.status IS DISTINCT FROM excluded.status
          OR races.distance IS DISTINCT FROM COALESCE(excluded.distance, races.distance)
          OR races.going IS DISTINCT FROM COALESCE(excluded.going, races.going)
          OR races.course_desc IS DISTINCT FROM COALESCE(excluded.course_desc, races.course_desc)
          OR races.course_code IS DISTINCT FROM COALESCE(excluded.course_code, races.course_code)
          OR races.race_class IS DISTINCT FROM COALESCE(excluded.race_class, races.race_class)
          OR races.data_source IS DISTINCT FROM excluded.data_source
          OR races.raw_json IS DISTINCT FROM COALESCE(excluded.raw_json, races.raw_json)`,
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
      `INSERT INTO runners (meeting_date, venue, race_no, horse_no, horse_code, name_en, name_ch, status, barrier, handicap_weight, jockey_en, trainer_en, last6run, data_source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(meeting_date, venue, race_no, horse_no) DO UPDATE SET
         horse_code=COALESCE(excluded.horse_code, runners.horse_code),
         name_en=COALESCE(excluded.name_en, runners.name_en),
         name_ch=COALESCE(excluded.name_ch, runners.name_ch),
         status=COALESCE(excluded.status, runners.status),
         barrier=COALESCE(excluded.barrier, runners.barrier),
         handicap_weight=COALESCE(excluded.handicap_weight, runners.handicap_weight),
         jockey_en=COALESCE(excluded.jockey_en, runners.jockey_en),
         trainer_en=COALESCE(excluded.trainer_en, runners.trainer_en),
         last6run=COALESCE(excluded.last6run, runners.last6run),
         data_source=excluded.data_source,
         updated_at=excluded.updated_at
       WHERE runners.horse_code IS DISTINCT FROM COALESCE(excluded.horse_code, runners.horse_code)
          OR runners.name_en IS DISTINCT FROM COALESCE(excluded.name_en, runners.name_en)
          OR runners.name_ch IS DISTINCT FROM COALESCE(excluded.name_ch, runners.name_ch)
          OR runners.status IS DISTINCT FROM COALESCE(excluded.status, runners.status)
          OR runners.barrier IS DISTINCT FROM COALESCE(excluded.barrier, runners.barrier)
          OR runners.handicap_weight IS DISTINCT FROM COALESCE(excluded.handicap_weight, runners.handicap_weight)
          OR runners.jockey_en IS DISTINCT FROM COALESCE(excluded.jockey_en, runners.jockey_en)
          OR runners.trainer_en IS DISTINCT FROM COALESCE(excluded.trainer_en, runners.trainer_en)
          OR runners.last6run IS DISTINCT FROM COALESCE(excluded.last6run, runners.last6run)
          OR runners.data_source IS DISTINCT FROM excluded.data_source`,
    )
    .bind(
      meetingDate,
      venue,
      raceNo,
      runner.horse_no,
      runner.horse_code,
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
      `INSERT INTO results (meeting_date, venue, race_no, horse_no, horse_code, final_position, dead_heat, win_odds, place_odds, dividends_json, data_source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(meeting_date, venue, race_no, horse_no) DO UPDATE SET
         horse_code=COALESCE(excluded.horse_code, results.horse_code),
         final_position=COALESCE(excluded.final_position, results.final_position),
         dead_heat=COALESCE(excluded.dead_heat, results.dead_heat),
         win_odds=COALESCE(excluded.win_odds, results.win_odds),
         place_odds=COALESCE(excluded.place_odds, results.place_odds),
         dividends_json=COALESCE(excluded.dividends_json, results.dividends_json),
         data_source=excluded.data_source,
         updated_at=excluded.updated_at
       WHERE results.horse_code IS DISTINCT FROM COALESCE(excluded.horse_code, results.horse_code)
          OR results.final_position IS DISTINCT FROM COALESCE(excluded.final_position, results.final_position)
          OR results.dead_heat IS DISTINCT FROM COALESCE(excluded.dead_heat, results.dead_heat)
          OR results.win_odds IS DISTINCT FROM COALESCE(excluded.win_odds, results.win_odds)
          OR results.place_odds IS DISTINCT FROM COALESCE(excluded.place_odds, results.place_odds)
          OR results.dividends_json IS DISTINCT FROM COALESCE(excluded.dividends_json, results.dividends_json)
          OR results.data_source IS DISTINCT FROM excluded.data_source`,
    )
    .bind(
      meetingDate,
      venue,
      raceNo,
      runner.horse_no,
      runner.horse_code,
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
  /** Prior snapshot before this insert (null on first observation). */
  previous: RaceOddsSnapshot | null;
}

/** Latest stored odds snapshot for a race, or null. */
export async function getLatestOddsSnapshot(
  db: D1Database,
  meetingDate: string,
  venue: string,
  raceNo: number,
): Promise<RaceOddsSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT raw_json FROM odds_snapshots
       WHERE meeting_date=? AND venue=? AND race_no=?
       ORDER BY snapshot_time DESC, id DESC LIMIT 1`,
    )
    .bind(meetingDate, venue, raceNo)
    .first<{ raw_json: string }>();
  if (!row) return null;
  try {
    return normalizeStoredSnapshot(JSON.parse(row.raw_json) as RaceOddsSnapshot);
  } catch {
    return null;
  }
}

export async function insertOddsSnapshotIfChanged(
  db: D1Database,
  meetingDate: string,
  venue: string,
  snapshot: RaceOddsSnapshot,
  dataSource = "graphql",
  sampleIntervalS: number | null = null,
  env?: Env,
): Promise<SnapshotInsertResult> {
  const hash = await contentHash(snapshot.payload);
  // ORDER BY snapshot_time (not id) so idx_odds_lookup
  // (meeting_date, venue, race_no, snapshot_time) serves filter+order as an
  // index seek: touches 1 row instead of scanning every snapshot of the race.
  // This runs on every poll tick (30s) x every race on race days.
  const existingRow = await db
    .prepare(
      `SELECT content_hash, raw_json FROM odds_snapshots
       WHERE meeting_date=? AND venue=? AND race_no=?
       ORDER BY snapshot_time DESC, id DESC LIMIT 1`,
    )
    .bind(meetingDate, venue, snapshot.race_no)
    .first<{ content_hash: string; raw_json: string }>();

  let previous: RaceOddsSnapshot | null = null;
  if (existingRow?.raw_json) {
    try {
      previous = normalizeStoredSnapshot(
        JSON.parse(existingRow.raw_json) as RaceOddsSnapshot,
      );
    } catch {
      previous = null;
    }
  }

  // Unchanged content hash: no write.
  if (existingRow?.content_hash === hash) {
    return {
      inserted: false,
      content_hash: hash,
      snapshot_time: snapshot.snapshot_time,
      previous,
    };
  }

  const result = await db
    .prepare(
      `INSERT INTO odds_snapshots (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at, sample_interval_s)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      sampleIntervalS,
    )
    .run();
  if (env) await trackD1Result(env, result);

  return {
    inserted: true,
    content_hash: hash,
    snapshot_time: snapshot.snapshot_time,
    previous,
  };
}

/**
 * True if this race previously had an open/selling pool or non-empty odds.
 * Used to distinguish genuine STOP_SELL (lock) from pre-sale STOP_SELL shells.
 */
export async function raceHadOpenOddsSnapshot(
  db: D1Database,
  meetingDate: string,
  venue: string,
  raceNo: number,
): Promise<boolean> {
  const rows = await db
    .prepare(
      `SELECT pool_status, raw_json FROM odds_snapshots
       WHERE meeting_date=? AND venue=? AND race_no=?
       ORDER BY snapshot_time DESC, id DESC
       LIMIT 20`,
    )
    .bind(meetingDate, venue, raceNo)
    .all<{ pool_status: string | null; raw_json: string }>();

  for (const row of rows.results ?? []) {
    const status = (row.pool_status ?? "").toUpperCase();
    if (status === "START_SELL" || status === "SELLING" || status === "SELL_STARTED") {
      return true;
    }
    try {
      const parsed = JSON.parse(row.raw_json) as {
        payload?: { win?: Record<string, unknown>; pla?: Record<string, unknown> };
        runners?: Array<{ win_odds?: number | null; place_odds?: number | null }>;
      };
      const win = parsed.payload?.win ?? {};
      const pla = parsed.payload?.pla ?? {};
      if (Object.keys(win).length > 0 || Object.keys(pla).length > 0) return true;
      if (
        (parsed.runners ?? []).some((r) => r.win_odds != null || r.place_odds != null)
      ) {
        return true;
      }
    } catch {
      // ignore malformed rows
    }
  }
  return false;
}

/**
 * Ensure a minimal horses row exists for brand-code lookups (/v1/horses/:code).
 * INSERT OR IGNORE — never overwrites HTML profiles; no extra HKJC requests.
 */
export async function ensureHorseStub(
  db: D1Database,
  runner: Pick<
    NormalizedRunner,
    "horse_code" | "horse_id" | "name_en" | "name_ch"
  >,
): Promise<void> {
  if (!runner.horse_code) return;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO horses
        (horse_code, horse_id, name_en, name_ch, data_source, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, 'graphql', ?, ?)`,
    )
    .bind(
      runner.horse_code,
      runner.horse_id,
      runner.name_en,
      runner.name_ch,
      now,
      now,
    )
    .run();
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
      await ensureHorseStub(db, runner);
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

/**
 * One-shot backfill of runners.horse_code / results.horse_code from stored
 * meetings.raw_json (GraphQL raceMeetings payload). No HKJC network calls.
 * Returns number of runner rows updated.
 */
export async function backfillHorseCodesFromRawMeetings(
  db: D1Database,
  opts?: { limitMeetings?: number },
): Promise<{ meetings_scanned: number; runners_updated: number }> {
  const limit = opts?.limitMeetings ?? 200;
  const { results } = await db
    .prepare(
      `SELECT meeting_date, venue, raw_json FROM meetings
       WHERE raw_json IS NOT NULL
       ORDER BY meeting_date DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ meeting_date: string; venue: string; raw_json: string }>();

  let runners_updated = 0;
  for (const row of results ?? []) {
    let parsed: {
      races?: Array<{
        no?: number;
        runners?: Array<{
          no?: string | number;
          standbyNo?: string | number;
          horse?: { code?: string; id?: string } | null;
          name_en?: string | null;
          name_ch?: string | null;
        }>;
      }>;
    };
    try {
      parsed = JSON.parse(row.raw_json);
    } catch {
      continue;
    }
    for (const race of parsed.races ?? []) {
      const raceNo = Number(race.no);
      if (!Number.isFinite(raceNo)) continue;
      for (const r of race.runners ?? []) {
        const code = normalizeHorseCode(r.horse?.code);
        if (!code) continue;
        const primary = Number(r.no);
        const standby = Number(r.standbyNo);
        const horseNo = Number.isFinite(primary) && primary > 0
          ? primary
          : Number.isFinite(standby) && standby > 0
            ? standby
            : NaN;
        if (!Number.isFinite(horseNo)) continue;
        const horseId =
          r.horse?.id != null && String(r.horse.id).trim() !== ""
            ? String(r.horse.id).trim()
            : null;
        const upd = await db
          .prepare(
            `UPDATE runners SET horse_code=?, updated_at=?
             WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?
               AND (horse_code IS NULL OR horse_code='')`,
          )
          .bind(
            code,
            new Date().toISOString(),
            row.meeting_date,
            row.venue,
            raceNo,
            horseNo,
          )
          .run();
        if ((upd.meta?.changes ?? 0) > 0) runners_updated += 1;
        await db
          .prepare(
            `UPDATE results SET horse_code=?
             WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?
               AND (horse_code IS NULL OR horse_code='')`,
          )
          .bind(code, row.meeting_date, row.venue, raceNo, horseNo)
          .run();
        await ensureHorseStub(db, {
          horse_code: code,
          horse_id: horseId,
          name_en: r.name_en ?? null,
          name_ch: r.name_ch ?? null,
        });
      }
    }
  }
  return { meetings_scanned: (results ?? []).length, runners_updated };
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
  // Skip status-only / empty dividend shells (pre-race DEFINED pools).
  const hasDiv = pools.some((p) => Array.isArray(p.dividends) && p.dividends.length > 0);
  if (!hasDiv) return;

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
           updated_at=excluded.updated_at
         WHERE results.dividends_json IS DISTINCT FROM excluded.dividends_json
            OR results.data_source IS DISTINCT FROM excluded.data_source`,
      )
      .bind(meetingDate, venue, raceNo, horseNo, json, dataSource, new Date().toISOString())
      .run();
  }
  // Also attach dividends_json onto existing result rows for this race
  await db
    .prepare(
      `UPDATE results SET dividends_json=?, updated_at=?
       WHERE meeting_date=? AND venue=? AND race_no=?
         AND dividends_json IS DISTINCT FROM ?`,
    )
    .bind(json, new Date().toISOString(), meetingDate, venue, raceNo, json)
    .run();
}

/**
 * True when any result row for this race has a non-null dividends_json
 * (final race dividends published → race-day high-freq window can close).
 */
export async function raceHasPublishedDividends(
  db: D1Database,
  meetingDate: string,
  venue: string,
  raceNo: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM results
       WHERE meeting_date=? AND venue=? AND race_no=?
         AND dividends_json IS NOT NULL AND TRIM(dividends_json) NOT IN ('', 'null', '[]')
       LIMIT 1`,
    )
    .bind(meetingDate, venue, raceNo)
    .first<{ ok: number }>();
  return row != null;
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO worker_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
       WHERE worker_meta.value IS DISTINCT FROM excluded.value`,
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
