import type { Env } from "../env";
import { envNum } from "../env";
import type { RaceOddsSnapshot } from "../parse/odds";
import type { OddsDeltaChange, PushRace } from "./envelope";

/** Full odds_update at most this often per race (default 300s). */
export const DEFAULT_PUSH_FULL_SNAPSHOT_INTERVAL_SEC = 300;
/** Coalesce same-meeting odds changes within this window (default 2000ms). */
export const DEFAULT_PUSH_COALESCE_MS = 2000;
/**
 * Outside the race-day high-freq window, coalesce deltas over this many
 * seconds (default 300). Overrides PUSH_COALESCE_MS when off-window.
 */
export const DEFAULT_PUSH_OFFWINDOW_COALESCE_SEC = 300;
/**
 * Force flush when the oldest buffered captured_at exceeds this many seconds
 * (default 20). Prevents off-window coalesce from holding deltas for ~300s.
 */
export const DEFAULT_PUSH_COALESCE_MAX_AGE_SEC = 20;
/**
 * Heartbeat inside the race-day high-frequency window (default 300s).
 * Env key remains HEARTBEAT_INTERVAL_SEC for raceday cadence.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_SEC = 300;
/** Heartbeat outside the race-day window / non-race days (default 1800s). */
export const DEFAULT_OFFDAY_HEARTBEAT_INTERVAL_SEC = 1800;
/**
 * High-freq window opens this many seconds before the first race post time
 * (default 7200 = 2h).
 */
export const DEFAULT_RACEDAY_WINDOW_BEFORE_SEC = 7200;

export function pushFullSnapshotIntervalSec(env: Env): number {
  return Math.max(
    1,
    envNum(env, "PUSH_FULL_SNAPSHOT_INTERVAL_SEC", DEFAULT_PUSH_FULL_SNAPSHOT_INTERVAL_SEC),
  );
}

export function pushCoalesceMs(env: Env): number {
  return Math.max(0, envNum(env, "PUSH_COALESCE_MS", DEFAULT_PUSH_COALESCE_MS));
}

export function pushOffwindowCoalesceSec(env: Env): number {
  return Math.max(
    0,
    envNum(env, "PUSH_OFFWINDOW_COALESCE_SEC", DEFAULT_PUSH_OFFWINDOW_COALESCE_SEC),
  );
}

export function pushCoalesceMaxAgeSec(env: Env): number {
  return Math.max(
    0,
    envNum(env, "PUSH_COALESCE_MAX_AGE_SEC", DEFAULT_PUSH_COALESCE_MAX_AGE_SEC),
  );
}

/**
 * In-window: PUSH_COALESCE_MS (default 2s).
 * Off-window: PUSH_OFFWINDOW_COALESCE_SEC (default 300s).
 */
export function resolveCoalesceMs(env: Env, inHighFreqWindow: boolean): number {
  if (inHighFreqWindow) return pushCoalesceMs(env);
  return pushOffwindowCoalesceSec(env) * 1000;
}

export function heartbeatIntervalSec(env: Env): number {
  return Math.max(
    1,
    envNum(env, "HEARTBEAT_INTERVAL_SEC", DEFAULT_HEARTBEAT_INTERVAL_SEC),
  );
}

export function heartbeatIntervalMs(env: Env): number {
  return heartbeatIntervalSec(env) * 1000;
}

export function offdayHeartbeatIntervalSec(env: Env): number {
  return Math.max(
    1,
    envNum(env, "OFFDAY_HEARTBEAT_INTERVAL_SEC", DEFAULT_OFFDAY_HEARTBEAT_INTERVAL_SEC),
  );
}

export function racedayWindowBeforeSec(env: Env): number {
  return Math.max(
    0,
    envNum(env, "RACEDAY_WINDOW_BEFORE_SEC", DEFAULT_RACEDAY_WINDOW_BEFORE_SEC),
  );
}

/**
 * Resolve effective heartbeat interval: raceday (HEARTBEAT_INTERVAL_SEC) inside
 * the high-freq window, otherwise OFFDAY_HEARTBEAT_INTERVAL_SEC.
 */
export function resolveEffectiveHeartbeatIntervalMs(
  env: Env,
  inHighFreqWindow: boolean,
): number {
  const sec = inHighFreqWindow
    ? heartbeatIntervalSec(env)
    : offdayHeartbeatIntervalSec(env);
  return sec * 1000;
}

/**
 * Race-day high-frequency window:
 * [first_post - RACEDAY_WINDOW_BEFORE_SEC, final_race_dividends_published).
 *
 * - `firstPostMs`: earliest race post_time (ms), or null if unknown → not in window.
 * - `finalDividendsPublished`: true once the meeting's last race has dividends.
 * - Inclusive start, exclusive end once dividends are published.
 */
export function isInRaceDayHighFreqWindow(args: {
  nowMs: number;
  firstPostMs: number | null;
  finalDividendsPublished: boolean;
  windowBeforeSec: number;
}): boolean {
  if (args.finalDividendsPublished) return false;
  if (args.firstPostMs == null || !Number.isFinite(args.firstPostMs)) return false;
  const startMs = args.firstPostMs - args.windowBeforeSec * 1000;
  return args.nowMs >= startMs;
}

/** Earliest finite post_time among races, or null. */
export function firstRacePostMs(
  races: Array<{ post_time?: string | null }>,
): number | null {
  let best: number | null = null;
  for (const r of races) {
    if (!r.post_time) continue;
    const ms = Date.parse(r.post_time);
    if (!Number.isFinite(ms)) continue;
    if (best == null || ms < best) best = ms;
  }
  return best;
}

/** Highest race_no among races (for “final race” dividends check). */
export function finalRaceNo(
  races: Array<{ race_no: number }>,
): number | null {
  if (races.length === 0) return null;
  return Math.max(...races.map((r) => r.race_no));
}

/**
 * Whether this race should be included in a full `odds_update` snapshot push.
 * D1 still stores every hash-changed tick; this only gates the push.
 */
export function shouldPushFullSnapshot(args: {
  previous: RaceOddsSnapshot | null;
  next: RaceOddsSnapshot;
  lastFullSnapshotAtMs: number | null;
  nowMs: number;
  fullSnapshotIntervalSec: number;
}): boolean {
  if (args.previous == null) return true;
  if ((args.previous.pool_status ?? null) !== (args.next.pool_status ?? null)) {
    return true;
  }
  if (args.lastFullSnapshotAtMs == null) return true;
  const elapsed = args.nowMs - args.lastFullSnapshotAtMs;
  return elapsed >= args.fullSnapshotIntervalSec * 1000;
}

/** Pool status flipped between prev and next (either may be null). */
export function poolStatusChanged(
  previous: RaceOddsSnapshot | null,
  next: RaceOddsSnapshot,
): boolean {
  if (previous == null) return false;
  return (previous.pool_status ?? null) !== (next.pool_status ?? null);
}

/**
 * Heartbeat / keepalive gate: at most once per HEARTBEAT_INTERVAL_SEC, and
 * only when nothing else was pushed in that window (`lastAnyPushAtMs`).
 */
export function shouldEmitHeartbeat(args: {
  nowMs: number;
  lastAnyPushAtMs: number | null;
  heartbeatIntervalMs: number;
}): boolean {
  if (args.lastAnyPushAtMs == null) return true;
  return args.nowMs - args.lastAnyPushAtMs >= args.heartbeatIntervalMs;
}

/**
 * When heartbeat is due and a periodic full snapshot is also due, emit one
 * `odds_update` instead of `no_update` so the receiver answers once per window.
 *
 * Outside the race-day high-freq window, always prefer a merged odds_update
 * keepalive when races are available (`forceMergedSnapshot`).
 */
export function preferSnapshotOverHeartbeat(args: {
  heartbeatDue: boolean;
  snapshotDue: boolean;
  /** Outside raceday window: merge heartbeat + full snapshot whenever due. */
  forceMergedSnapshot?: boolean;
  hasRaces?: boolean;
}): "odds_update" | "no_update" | null {
  if (!args.heartbeatDue && !args.snapshotDue) return null;
  if (
    args.forceMergedSnapshot &&
    args.heartbeatDue &&
    args.hasRaces !== false
  ) {
    return "odds_update";
  }
  if (args.snapshotDue) return "odds_update";
  if (args.heartbeatDue) return "no_update";
  return null;
}

/** Annotated change row for live-coalesced odds_delta (additive 1.1 fields). */
export type AnnotatedOddsChange = OddsDeltaChange & {
  captured_at: string;
  seq: number;
  sample_interval_s: number | null;
};

/** One observation batch waiting inside the coalesce window. */
export interface CoalesceBatch {
  captured_at: string;
  sample_interval_s: number | null;
  /**
   * Optional legacy / test provisional seq. Live enqueue no longer allocates;
   * flush stamps the single emitPush seq onto all changes.
   */
  seq?: number;
  changes: OddsDeltaChange[];
  races: PushRace[];
  race_nos: number[];
  source_last_updated_at: string | null;
}

export interface CoalesceBuffer {
  /** When the current window opened (first batch). */
  opened_at_ms: number;
  batches: CoalesceBatch[];
}

export function appendCoalesceBatch(
  buffer: CoalesceBuffer | null,
  batch: CoalesceBatch,
  nowMs: number,
): CoalesceBuffer {
  if (!buffer || buffer.batches.length === 0) {
    return { opened_at_ms: nowMs, batches: [batch] };
  }
  return { opened_at_ms: buffer.opened_at_ms, batches: [...buffer.batches, batch] };
}

export function coalesceWindowElapsed(
  buffer: CoalesceBuffer | null,
  nowMs: number,
  coalesceMs: number,
): boolean {
  if (!buffer || buffer.batches.length === 0) return false;
  if (coalesceMs <= 0) return true;
  return nowMs - buffer.opened_at_ms >= coalesceMs;
}

/** Earliest batch captured_at as epoch ms; falls back to opened_at_ms. */
export function coalesceOldestCapturedAtMs(buffer: CoalesceBuffer): number {
  let oldest = Infinity;
  for (const b of buffer.batches) {
    const ms = Date.parse(b.captured_at);
    if (Number.isFinite(ms)) oldest = Math.min(oldest, ms);
  }
  return Number.isFinite(oldest) ? oldest : buffer.opened_at_ms;
}

/**
 * True when the oldest buffered observation is older than maxAgeSec.
 * maxAgeSec <= 0 disables the check.
 */
export function coalesceMaxAgeElapsed(
  buffer: CoalesceBuffer | null,
  nowMs: number,
  maxAgeSec: number,
): boolean {
  if (!buffer || buffer.batches.length === 0) return false;
  if (maxAgeSec <= 0) return false;
  return nowMs - coalesceOldestCapturedAtMs(buffer) >= maxAgeSec * 1000;
}

/**
 * Next wake deadline for an open coalesce buffer: min(window end, max-age end).
 */
export function coalesceFlushDeadlineMs(
  buffer: CoalesceBuffer,
  coalesceMs: number,
  maxAgeSec: number,
): number {
  const windowDeadline =
    coalesceMs > 0 ? buffer.opened_at_ms + coalesceMs : buffer.opened_at_ms;
  if (maxAgeSec <= 0) return windowDeadline;
  const ageDeadline = coalesceOldestCapturedAtMs(buffer) + maxAgeSec * 1000;
  return Math.min(windowDeadline, ageDeadline);
}

/**
 * Flatten buffered batches into one odds_delta payload.
 * Each change keeps its originating captured_at / sample_interval_s.
 * Seq is stamped at flush (single allocatePushSeq via emitPush).
 */
export function flattenCoalesceBuffer(buffer: CoalesceBuffer): {
  changes: AnnotatedOddsChange[];
  races: PushRace[];
  race_nos: number[];
  source_last_updated_at: string | null;
  captured_at: string;
  sample_interval_s: number | null;
  covered_seq_from: number;
  covered_seq_to: number;
} {
  const changes: AnnotatedOddsChange[] = [];
  const raceMap = new Map<number, PushRace>();
  const raceNos = new Set<number>();
  let source: string | null = null;
  let sourceMs = -Infinity;
  let coveredFrom = Infinity;
  let coveredTo = -Infinity;
  let lastCaptured = buffer.batches[0]?.captured_at ?? "";
  let lastSample: number | null = buffer.batches[0]?.sample_interval_s ?? null;

  for (const batch of buffer.batches) {
    if (batch.seq != null && Number.isFinite(batch.seq)) {
      coveredFrom = Math.min(coveredFrom, batch.seq);
      coveredTo = Math.max(coveredTo, batch.seq);
    }
    lastCaptured = batch.captured_at;
    lastSample = batch.sample_interval_s;
    for (const c of batch.changes) {
      changes.push({
        ...c,
        captured_at: batch.captured_at,
        // Provisional / legacy only; flush overwrites with the emit seq.
        seq: batch.seq ?? 0,
        sample_interval_s: batch.sample_interval_s,
      });
    }
    for (const r of batch.races) {
      raceMap.set(r.race_no, r);
    }
    for (const n of batch.race_nos) raceNos.add(n);
    if (batch.source_last_updated_at) {
      const ms = Date.parse(batch.source_last_updated_at);
      if (Number.isFinite(ms) && ms >= sourceMs) {
        sourceMs = ms;
        source = batch.source_last_updated_at;
      }
    }
  }

  return {
    changes,
    races: [...raceMap.values()].sort((a, b) => a.race_no - b.race_no),
    race_nos: [...raceNos].sort((a, b) => a - b),
    source_last_updated_at: source,
    captured_at: lastCaptured,
    sample_interval_s: lastSample,
    covered_seq_from: Number.isFinite(coveredFrom) ? coveredFrom : 0,
    covered_seq_to: Number.isFinite(coveredTo) ? coveredTo : 0,
  };
}
