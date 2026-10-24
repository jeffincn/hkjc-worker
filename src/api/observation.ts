/**
 * Odds observation timestamps for analysis consumers (issue #38 P0).
 *
 * Distinguishes successful poll presence (poll_ticks) from content-hash
 * changes (odds_snapshots / poll_ticks.changed=1) and official pool
 * lastUpdateTime (source_updated_at — null when HKJC omitted it).
 */
import type { Env } from "../env";
import { resolvePollIntervalMs } from "../poll/live";
import type { RaceOddsSnapshot } from "../parse/odds";
import { POLL_GAP_THRESHOLD_MS } from "../store/poll-ticks";

export type OddsPoolKey = "WIN" | "PLA";

export interface PoolObservation {
  /** Last poll_ticks.tick_time for this race (any successful poll). */
  last_successful_poll_at: string | null;
  /** Last poll where odds content hash changed (poll_ticks.changed=1). */
  last_content_change_at: string | null;
  /**
   * Official pmPools.lastUpdateTime for this pool.
   * Null when HKJC omitted it — never filled with local clock.
   */
  source_updated_at: string | null;
  /** Official pmPools.sellStatus for this pool (null if unknown). */
  sell_status: string | null;
  /** Same as sell_status (alias matching existing snapshot.pool_status naming). */
  pool_status: string | null;
  /** Wall clock when this API response was built (ISO). */
  returned_at: string;
  /** Configured live poll interval in seconds (from POLL_INTERVAL_MS). */
  sample_interval_s: number | null;
}

export interface RaceObservation {
  returned_at: string;
  sample_interval_s: number | null;
  last_successful_poll_at: string | null;
  last_content_change_at: string | null;
  /**
   * COLLECTION_FAILURE threshold from issue #26 (10 minutes).
   * Cards should still surface 30s/60s observation age independently.
   */
  collection_failure_threshold_ms: number;
  pools: Record<OddsPoolKey, PoolObservation>;
}

export interface RacePollTimes {
  last_successful_poll_at: string | null;
  last_content_change_at: string | null;
}

export function sampleIntervalSeconds(env: Env): number {
  return Math.round(resolvePollIntervalMs(env) / 1000);
}

export async function loadRacePollTimes(
  db: D1Database,
  meetingDate: string,
  venue: string,
  raceNo: number,
): Promise<RacePollTimes> {
  const row = await db
    .prepare(
      `SELECT
         MAX(tick_time) AS last_successful_poll_at,
         MAX(CASE WHEN changed=1 THEN tick_time END) AS last_content_change_at
       FROM poll_ticks
       WHERE meeting_date=? AND venue=? AND race_no=?`,
    )
    .bind(meetingDate, venue, raceNo)
    .first<{
      last_successful_poll_at: string | null;
      last_content_change_at: string | null;
    }>();
  return {
    last_successful_poll_at: row?.last_successful_poll_at ?? null,
    last_content_change_at: row?.last_content_change_at ?? null,
  };
}

/** Batch poll-time summary for all races of a meeting (listRaces). */
export async function loadMeetingPollTimes(
  db: D1Database,
  meetingDate: string,
  venue: string,
): Promise<Map<number, RacePollTimes>> {
  const { results } = await db
    .prepare(
      `SELECT
         race_no,
         MAX(tick_time) AS last_successful_poll_at,
         MAX(CASE WHEN changed=1 THEN tick_time END) AS last_content_change_at
       FROM poll_ticks
       WHERE meeting_date=? AND venue=?
       GROUP BY race_no`,
    )
    .bind(meetingDate, venue)
    .all<{
      race_no: number;
      last_successful_poll_at: string | null;
      last_content_change_at: string | null;
    }>();
  const map = new Map<number, RacePollTimes>();
  for (const r of results ?? []) {
    map.set(r.race_no, {
      last_successful_poll_at: r.last_successful_poll_at ?? null,
      last_content_change_at: r.last_content_change_at ?? null,
    });
  }
  return map;
}

function poolMetaFromSnapshot(
  snap: RaceOddsSnapshot | null | undefined,
  pool: OddsPoolKey,
): { source_updated_at: string | null; sell_status: string | null } {
  const meta = snap?.pool_meta?.[pool];
  if (meta) {
    return {
      source_updated_at: meta.source_updated_at ?? null,
      sell_status: meta.sell_status ?? null,
    };
  }
  // Legacy snapshots: do not invent official source time.
  // sell_status may fall back to race-level pool_status (documented).
  return {
    source_updated_at: null,
    sell_status: snap?.pool_status ?? null,
  };
}

export function buildRaceObservation(args: {
  env: Env;
  poll: RacePollTimes;
  snapshot?: RaceOddsSnapshot | null;
  /** Override sample interval (e.g. from odds_snapshots.sample_interval_s). */
  sample_interval_s?: number | null;
  returned_at?: string;
}): RaceObservation {
  const returned_at = args.returned_at ?? new Date().toISOString();
  const sample_interval_s =
    args.sample_interval_s != null && Number.isFinite(args.sample_interval_s)
      ? Number(args.sample_interval_s)
      : sampleIntervalSeconds(args.env);
  const last_successful_poll_at = args.poll.last_successful_poll_at;
  const last_content_change_at = args.poll.last_content_change_at;

  const mk = (pool: OddsPoolKey): PoolObservation => {
    const meta = poolMetaFromSnapshot(args.snapshot, pool);
    return {
      last_successful_poll_at,
      last_content_change_at,
      source_updated_at: meta.source_updated_at,
      sell_status: meta.sell_status,
      pool_status: meta.sell_status,
      returned_at,
      sample_interval_s,
    };
  };

  return {
    returned_at,
    sample_interval_s,
    last_successful_poll_at,
    last_content_change_at,
    collection_failure_threshold_ms: POLL_GAP_THRESHOLD_MS,
    pools: {
      WIN: mk("WIN"),
      PLA: mk("PLA"),
    },
  };
}
