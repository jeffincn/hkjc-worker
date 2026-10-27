import type { Env } from "../env";
import {
  cellToJson,
  segmentsToJson,
  type ParsedSectionalPage,
  type SectionalHorseRow,
} from "../html/sectional";
import { trackD1Result } from "./d1-budget";

export interface SectionalUpsertResult {
  changed: boolean;
  content_hash: string;
  rows: number;
  skipped_no_code: number;
}

/**
 * Collapse duplicate horse_code rows in one race (last-wins).
 * Parsed pages can occasionally emit the same brand code twice; PK is
 * (meeting_date, venue, race_no, horse_code), so duplicates must not reach INSERT.
 */
export function dedupeSectionalHorses(
  horses: SectionalHorseRow[],
): { horses: SectionalHorseRow[]; skipped_no_code: number } {
  let skipped_no_code = 0;
  const byCode = new Map<string, SectionalHorseRow>();
  for (const h of horses) {
    if (!h.horse_code) {
      skipped_no_code++;
      continue;
    }
    byCode.set(h.horse_code, h);
  }
  return { horses: [...byCode.values()], skipped_no_code };
}

export async function replaceRaceSectionals(
  db: D1Database,
  args: {
    meeting_date: string;
    venue: string;
    race_no: number;
    race_info: string | null;
    horses: SectionalHorseRow[];
    source_url: string;
    content_hash: string;
    scraped_at?: string;
    env?: Env;
  },
): Promise<SectionalUpsertResult> {
  const scraped_at = args.scraped_at ?? new Date().toISOString();
  const prev = await db
    .prepare(
      `SELECT content_hash FROM sectional_ingest_progress
       WHERE meeting_date=? AND venue=? AND race_no=?`,
    )
    .bind(args.meeting_date, args.venue, args.race_no)
    .first<{ content_hash: string | null }>();

  if (prev?.content_hash === args.content_hash) {
    return {
      changed: false,
      content_hash: args.content_hash,
      rows: 0,
      skipped_no_code: 0,
    };
  }

  const { horses, skipped_no_code } = dedupeSectionalHorses(args.horses);

  await db
    .prepare(
      `DELETE FROM sectional_times WHERE meeting_date=? AND venue=? AND race_no=?`,
    )
    .bind(args.meeting_date, args.venue, args.race_no)
    .run();

  let rows = 0;
  for (const h of horses) {
    const secs = h.sections;
    // INSERT OR REPLACE: survive partial prior writes / residual PK collisions.
    const result = await db
      .prepare(
        `INSERT OR REPLACE INTO sectional_times (
          meeting_date, venue, race_no, horse_code, horse_name, horse_no,
          finishing_order, finish_time, finish_time_sec, race_info,
          sec1_json, sec2_json, sec3_json, sec4_json, sec5_json, sec6_json,
          segments_json, source_url, content_hash, scraped_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        args.meeting_date,
        args.venue,
        args.race_no,
        h.horse_code,
        h.horse_name,
        h.horse_no,
        h.finishing_order,
        h.finish_time,
        h.finish_time_sec,
        args.race_info,
        cellToJson(secs[0] ?? null),
        cellToJson(secs[1] ?? null),
        cellToJson(secs[2] ?? null),
        cellToJson(secs[3] ?? null),
        cellToJson(secs[4] ?? null),
        cellToJson(secs[5] ?? null),
        segmentsToJson(h.segments),
        args.source_url,
        args.content_hash,
        scraped_at,
      )
      .run();
    if (args.env) await trackD1Result(args.env, result);
    rows++;
  }

  await markSectionalProgress(db, {
    meeting_date: args.meeting_date,
    venue: args.venue,
    race_no: args.race_no,
    status: rows > 0 ? "done" : "empty",
    content_hash: args.content_hash,
    source_url: args.source_url,
    scraped_at,
    error_message: null,
    env: args.env,
  });

  return {
    changed: true,
    content_hash: args.content_hash,
    rows,
    skipped_no_code,
  };
}

export async function markSectionalProgress(
  db: D1Database,
  args: {
    meeting_date: string;
    venue: string;
    race_no: number;
    status: string;
    content_hash?: string | null;
    source_url?: string | null;
    scraped_at?: string | null;
    error_message?: string | null;
    env?: Env;
  },
): Promise<void> {
  const result = await db
    .prepare(
      `INSERT INTO sectional_ingest_progress (
         meeting_date, venue, race_no, status, content_hash, source_url, scraped_at, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(meeting_date, venue, race_no) DO UPDATE SET
         status=excluded.status,
         content_hash=COALESCE(excluded.content_hash, sectional_ingest_progress.content_hash),
         source_url=COALESCE(excluded.source_url, sectional_ingest_progress.source_url),
         scraped_at=COALESCE(excluded.scraped_at, sectional_ingest_progress.scraped_at),
         error_message=excluded.error_message`,
    )
    .bind(
      args.meeting_date,
      args.venue,
      args.race_no,
      args.status,
      args.content_hash ?? null,
      args.source_url ?? null,
      args.scraped_at ?? null,
      args.error_message ?? null,
    )
    .run();
  if (args.env) await trackD1Result(args.env, result);
}

export async function isSectionalRaceDone(
  db: D1Database,
  meeting_date: string,
  venue: string,
  race_no: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT status FROM sectional_ingest_progress
       WHERE meeting_date=? AND venue=? AND race_no=?`,
    )
    .bind(meeting_date, venue, race_no)
    .first<{ status: string }>();
  return row?.status === "done";
}

export function pageToStoreArgs(
  page: ParsedSectionalPage,
  fallback: { meeting_date: string; venue: string; race_no: number },
): {
  meeting_date: string;
  venue: string;
  race_no: number;
  race_info: string | null;
  horses: SectionalHorseRow[];
  source_url: string;
} {
  return {
    meeting_date: page.meeting_date ?? fallback.meeting_date,
    venue: page.venue ?? fallback.venue,
    race_no: page.race_no ?? fallback.race_no,
    race_info: page.race_info,
    horses: page.horses,
    source_url: page.source_url,
  };
}

export async function listSectionals(
  db: D1Database,
  args: { meeting_date: string; venue: string; race_no?: number | null },
): Promise<
  Array<{
    meeting_date: string;
    venue: string;
    race_no: number;
    horse_code: string;
    horse_name: string | null;
    horse_no: number | null;
    finishing_order: number | null;
    finish_time: string | null;
    finish_time_sec: number | null;
    race_info: string | null;
    sec1_json: string | null;
    sec2_json: string | null;
    sec3_json: string | null;
    sec4_json: string | null;
    sec5_json: string | null;
    sec6_json: string | null;
    segments_json: string | null;
    source_url: string | null;
    content_hash: string | null;
    scraped_at: string;
  }>
> {
  if (args.race_no != null) {
    const { results } = await db
      .prepare(
        `SELECT * FROM sectional_times
         WHERE meeting_date=? AND venue=? AND race_no=?
         ORDER BY finishing_order, horse_no`,
      )
      .bind(args.meeting_date, args.venue, args.race_no)
      .all();
    return (results ?? []) as Awaited<ReturnType<typeof listSectionals>>;
  }
  const { results } = await db
    .prepare(
      `SELECT * FROM sectional_times
       WHERE meeting_date=? AND venue=?
       ORDER BY race_no, finishing_order, horse_no`,
    )
    .bind(args.meeting_date, args.venue)
    .all();
  return (results ?? []) as Awaited<ReturnType<typeof listSectionals>>;
}
