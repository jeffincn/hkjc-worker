/**
 * Paginated / as-of odds snapshot query (issue #38 P1 R5).
 *
 * Filters by persisted time (`odds_snapshots.created_at`), never by
 * official `snapshot_time` / source lastUpdateTime — so an as_of cutoff
 * cannot leak rows that arrived after t even if their source time is earlier.
 *
 * Does not alter GET /v1/odds/history.
 */
import {
  clampMaxBytes,
  packItemsUnderBudget,
  QUERY_MAX_BYTES_DEFAULT,
} from "./byte-page";

export {
  clampMaxBytes,
  packItemsUnderBudget,
  QUERY_MAX_BYTES_CAP,
  QUERY_MAX_BYTES_DEFAULT,
} from "./byte-page";

/** @deprecated Use QUERY_MAX_BYTES_DEFAULT (1.2MB A2 cap). */
export const ODDS_SNAPSHOTS_MAX_BYTES = QUERY_MAX_BYTES_DEFAULT;
export const ODDS_SNAPSHOTS_DEFAULT_LIMIT = 50;
export const ODDS_SNAPSHOTS_MAX_LIMIT = 200;

export interface OddsSnapshotQueryRow {
  id: number;
  snapshot_time: string;
  content_hash: string;
  pool_status: string | null;
  raw_json: string;
  data_source: string;
  created_at: string;
  sample_interval_s: number | null;
}

export interface OddsSnapshotQueryArgs {
  meeting_date: string;
  venue: string;
  race_no: number;
  /** Cursor: only rows with id > since_id (like /v1/events since_seq). */
  since_id: number;
  /**
   * Cutoff on persisted/available time (`created_at`).
   * Null = no upper bound.
   */
  as_of: string | null;
  limit: number;
}

export function clampOddsSnapshotsLimit(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return ODDS_SNAPSHOTS_DEFAULT_LIMIT;
  const n = Math.floor(Number(raw));
  if (n < 1) return 1;
  return Math.min(n, ODDS_SNAPSHOTS_MAX_LIMIT);
}

/**
 * Fetch up to `limit + 1` rows to detect has_more, ordered by id ASC.
 * as_of filters `created_at <= as_of`.
 */
export async function queryOddsSnapshotsPage(
  db: D1Database,
  args: OddsSnapshotQueryArgs,
): Promise<OddsSnapshotQueryRow[]> {
  const fetchLimit = Math.min(args.limit + 1, ODDS_SNAPSHOTS_MAX_LIMIT + 1);
  if (args.as_of) {
    const { results } = await db
      .prepare(
        `SELECT id, snapshot_time, content_hash, pool_status, raw_json,
                data_source, created_at, sample_interval_s
         FROM odds_snapshots
         WHERE meeting_date=? AND venue=? AND race_no=?
           AND id > ?
           AND created_at <= ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .bind(
        args.meeting_date,
        args.venue,
        args.race_no,
        args.since_id,
        args.as_of,
        fetchLimit,
      )
      .all<OddsSnapshotQueryRow>();
    return results ?? [];
  }
  const { results } = await db
    .prepare(
      `SELECT id, snapshot_time, content_hash, pool_status, raw_json,
              data_source, created_at, sample_interval_s
       FROM odds_snapshots
       WHERE meeting_date=? AND venue=? AND race_no=?
         AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .bind(
      args.meeting_date,
      args.venue,
      args.race_no,
      args.since_id,
      fetchLimit,
    )
    .all<OddsSnapshotQueryRow>();
  return results ?? [];
}

/** @deprecated Prefer packItemsUnderBudget from byte-page. */
export const packSnapshotsUnderBudget = packItemsUnderBudget;
