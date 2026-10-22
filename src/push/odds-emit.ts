import type { Env } from "../env";
import type { RaceOddsSnapshot } from "../parse/odds";
import { buildPoolInvestments } from "./delta";
import {
  applyEmittedChangesToLastPushed,
  filterChangesAgainstLastPushed,
  lastPushedFromRaces,
  loadLastOddsUpdateHash,
  loadLastPushedOdds,
  oddsUpdateRacesHash,
  saveLastOddsUpdateHash,
  saveLastPushedOdds,
  type LastPushedOdds,
} from "./dedupe";
import { emitPush } from "./emit";
import type { OddsDeltaChange, PushRace } from "./envelope";
import type { PmPoolRaw } from "../graphql/types";
import {
  appendCoalesceBatch,
  coalesceMaxAgeElapsed,
  coalesceWindowElapsed,
  flattenCoalesceBuffer,
  preferSnapshotOverHeartbeat,
  pushCoalesceMaxAgeSec,
  resolveCoalesceMs,
  pushFullSnapshotIntervalSec,
  resolveEffectiveHeartbeatIntervalMs,
  shouldEmitHeartbeat,
  shouldPushFullSnapshot,
  type CoalesceBuffer,
  type CoalesceBatch,
} from "./odds-policy";
import { allocatePushSeq, getLastChange } from "./seq";
import { buildCompleteSnapshotRaces } from "./snapshot-coverage";

export type FullSnapshotByRace = Record<string, number>;

export function raceFullKey(raceNo: number): string {
  return String(raceNo);
}

export function decideFullSnapshotRaces(args: {
  env: Env;
  nowMs: number;
  lastFullByRace: FullSnapshotByRace;
  changed: Array<{
    previous: RaceOddsSnapshot | null;
    next: RaceOddsSnapshot;
    pushRace: PushRace;
  }>;
}): PushRace[] {
  const interval = pushFullSnapshotIntervalSec(args.env);
  const out: PushRace[] = [];
  for (const row of args.changed) {
    const last = args.lastFullByRace[raceFullKey(row.next.race_no)] ?? null;
    if (
      shouldPushFullSnapshot({
        previous: row.previous,
        next: row.next,
        lastFullSnapshotAtMs: last,
        nowMs: args.nowMs,
        fullSnapshotIntervalSec: interval,
      })
    ) {
      out.push(row.pushRace);
    }
  }
  return out;
}

export function markFullSnapshots(
  lastFullByRace: FullSnapshotByRace,
  races: PushRace[],
  nowMs: number,
): FullSnapshotByRace {
  const next = { ...lastFullByRace };
  for (const r of races) {
    next[raceFullKey(r.race_no)] = nowMs;
  }
  return next;
}

/** True when any known race is due for a periodic full snapshot. */
export function anyPeriodicSnapshotDue(args: {
  env: Env;
  nowMs: number;
  lastFullByRace: FullSnapshotByRace;
  raceNos: number[];
}): boolean {
  const intervalMs = pushFullSnapshotIntervalSec(args.env) * 1000;
  if (args.raceNos.length === 0) return false;
  for (const n of args.raceNos) {
    const last = args.lastFullByRace[raceFullKey(n)];
    if (last == null || args.nowMs - last >= intervalMs) return true;
  }
  return false;
}

/**
 * Drop empty / unchanged-vs-last-pushed delta rows. Returns null when nothing
 * remains to enqueue.
 */
export async function filterDeltaForPush(
  env: Env,
  meetingDate: string,
  venue: string,
  changes: OddsDeltaChange[],
  lastPushed?: LastPushedOdds | null,
): Promise<{ changes: OddsDeltaChange[]; lastPushed: LastPushedOdds } | null> {
  if (changes.length === 0) return null;
  const last =
    lastPushed ?? (await loadLastPushedOdds(env.DB, meetingDate, venue));
  const filtered = filterChangesAgainstLastPushed(changes, last);
  if (filtered.changes.length === 0) return null;
  return { changes: filtered.changes, lastPushed: filtered.next };
}

export async function enqueueOddsDeltaBatch(
  env: Env,
  buffer: CoalesceBuffer | null,
  args: {
    meeting_date: string;
    venue: string;
    nowMs: number;
    captured_at: string;
    sample_interval_s: number | null;
    changes: OddsDeltaChange[];
    races: PushRace[];
    race_nos: number[];
    source_last_updated_at: string | null;
  },
): Promise<CoalesceBuffer | null> {
  // Never buffer an empty changes[] payload. Do not allocate seq here —
  // flushOddsDeltaCoalesce allocates once via emitPush (hkjc-agent-runner#10).
  void env;
  if (args.changes.length === 0) return buffer;
  const batch: CoalesceBatch = {
    captured_at: args.captured_at,
    sample_interval_s: args.sample_interval_s,
    changes: args.changes,
    races: args.races,
    race_nos: args.race_nos,
    source_last_updated_at: args.source_last_updated_at,
  };
  return appendCoalesceBatch(buffer, batch, args.nowMs);
}

export async function flushOddsDeltaCoalesce(
  env: Env,
  buffer: CoalesceBuffer,
  args: {
    meeting_date: string;
    venue: string;
    poolInvs: PmPoolRaw[];
  },
): Promise<boolean> {
  const flat = flattenCoalesceBuffer(buffer);
  if (flat.changes.length === 0) return false;

  // Re-filter against last-pushed at flush time (state may have advanced).
  // If nothing remains, do not allocate / burn a seq number.
  const gated = await filterDeltaForPush(
    env,
    args.meeting_date,
    args.venue,
    flat.changes,
  );
  if (!gated) return false;

  // Single seq for the merged odds_delta (payload shape unchanged).
  const seq = await allocatePushSeq(env, args.meeting_date, args.venue);
  const changes = gated.changes.map((c) => ({ ...c, seq }));

  await emitPush(env, {
    event: "odds_delta",
    meeting_date: args.meeting_date,
    venue: args.venue,
    seq,
    races: flat.races,
    changes,
    pools: buildPoolInvestments(args.poolInvs, flat.race_nos),
    captured_at: flat.captured_at,
    sample_interval_s: flat.sample_interval_s,
    source_last_updated_at: flat.source_last_updated_at,
    meta:
      buffer.batches.length > 1
        ? {
            coalesced_batches: buffer.batches.length,
            covered_seq_from: seq,
            covered_seq_to: seq,
          }
        : undefined,
  });
  await saveLastPushedOdds(env, args.meeting_date, args.venue, gated.lastPushed);
  return true;
}

/**
 * Flush when the coalesce window has elapsed, max-age is exceeded, or
 * coalesceMs is 0 (immediate). Returns the remaining buffer (null if flushed).
 */
export async function maybeFlushOddsDeltaCoalesce(
  env: Env,
  buffer: CoalesceBuffer | null,
  args: {
    meeting_date: string;
    venue: string;
    poolInvs: PmPoolRaw[];
    nowMs: number;
    /** Force flush regardless of window (e.g. meeting done). */
    force?: boolean;
    /** When set, selects in-window vs off-window coalesce length. */
    inHighFreqWindow?: boolean;
    /** Override coalesce length (ms). */
    coalesceMs?: number;
    /** Override max age (sec). Race-day / off-window both capped. */
    maxAgeSec?: number;
  },
): Promise<{ buffer: CoalesceBuffer | null; flushed: boolean }> {
  if (!buffer || buffer.batches.length === 0) {
    return { buffer: null, flushed: false };
  }
  const coalesceMs =
    args.coalesceMs ??
    resolveCoalesceMs(env, args.inHighFreqWindow !== false);
  const maxAgeSec =
    args.maxAgeSec ?? pushCoalesceMaxAgeSec(env);
  // Cap buffer age so off-window 300s coalesce cannot hold stale captured_at
  // (jeffincn/hkjc-agent-runner#10). Applies whenever a buffer is open.
  const maxAgeDue = coalesceMaxAgeElapsed(buffer, args.nowMs, maxAgeSec);
  const due =
    args.force === true ||
    coalesceMs <= 0 ||
    coalesceWindowElapsed(buffer, args.nowMs, coalesceMs) ||
    maxAgeDue;
  if (!due) return { buffer, flushed: false };
  const ok = await flushOddsDeltaCoalesce(env, buffer, args);
  return { buffer: null, flushed: ok };
}

/**
 * Emit a full odds_update unless the stable races hash matches the last
 * pushed hash (survives DO restart via D1). Returns whether it was sent.
 */
export async function emitOddsUpdateIfChanged(args: {
  env: Env;
  meeting_date: string;
  venue: string;
  races: PushRace[];
  captured_at: string;
  sample_interval_s: number | null;
  source_last_updated_at: string | null;
  meta?: Record<string, unknown>;
  /** Optional DO-cached hash to avoid a D1 read. */
  cachedHash?: string | null;
}): Promise<{
  emitted: boolean;
  hash: string;
  lastFullByRaceUpdate: PushRace[];
}> {
  const hash = await oddsUpdateRacesHash(args.races);
  const last =
    args.cachedHash !== undefined
      ? args.cachedHash
      : await loadLastOddsUpdateHash(
          args.env.DB,
          args.meeting_date,
          args.venue,
        );
  if (last != null && last === hash) {
    return { emitted: false, hash, lastFullByRaceUpdate: [] };
  }
  await emitPush(args.env, {
    event: "odds_update",
    meeting_date: args.meeting_date,
    venue: args.venue,
    races: args.races,
    captured_at: args.captured_at,
    sample_interval_s: args.sample_interval_s,
    source_last_updated_at: args.source_last_updated_at,
    meta: args.meta,
  });
  await saveLastOddsUpdateHash(
    args.env,
    args.meeting_date,
    args.venue,
    hash,
  );
  // Full snapshot becomes the new last-pushed odds baseline.
  await saveLastPushedOdds(
    args.env,
    args.meeting_date,
    args.venue,
    lastPushedFromRaces(args.races),
  );
  return { emitted: true, hash, lastFullByRaceUpdate: args.races };
}

/**
 * Idle keepalive: prefer a single odds_update when a periodic full snapshot
 * is due in the same heartbeat window; otherwise no_update.
 *
 * Outside the race-day high-freq window, merge heartbeat + full snapshot
 * only when content changed since last push; otherwise no_update.
 */
export async function emitIdleKeepalive(args: {
  env: Env;
  nowMs: number;
  lastAnyPushAtMs: number | null;
  lastFullByRace: FullSnapshotByRace;
  meeting_date: string;
  venue: string;
  captured_at: string;
  sample_interval_s: number | null;
  source_last_updated_at: string | null;
  /** Latest push races for this meeting (from current tick fetch). */
  latestRaces: PushRace[];
  /** Meeting card race numbers (for coverage / D1 fill). */
  expectedRaceNos?: number[];
  /** Inside [first_post - before, final dividends). */
  inHighFreqWindow: boolean;
  /** DO-cached last odds_update content hash. */
  lastOddsUpdateHash?: string | null;
}): Promise<{
  emitted: "odds_update" | "no_update" | null;
  lastFullByRace: FullSnapshotByRace;
  heartbeatIntervalMs: number;
  lastOddsUpdateHash: string | null;
}> {
  const hbMs = resolveEffectiveHeartbeatIntervalMs(
    args.env,
    args.inHighFreqWindow,
  );
  const heartbeatDue = shouldEmitHeartbeat({
    nowMs: args.nowMs,
    lastAnyPushAtMs: args.lastAnyPushAtMs,
    heartbeatIntervalMs: hbMs,
  });
  if (!heartbeatDue) {
    return {
      emitted: null,
      lastFullByRace: args.lastFullByRace,
      heartbeatIntervalMs: hbMs,
      lastOddsUpdateHash: args.lastOddsUpdateHash ?? null,
    };
  }

  const expected =
    args.expectedRaceNos && args.expectedRaceNos.length > 0
      ? args.expectedRaceNos
      : args.latestRaces.map((r) => r.race_no);
  const raceNos = expected;
  const snapshotDue =
    (args.latestRaces.length > 0 || expected.length > 0) &&
    anyPeriodicSnapshotDue({
      env: args.env,
      nowMs: args.nowMs,
      lastFullByRace: args.lastFullByRace,
      raceNos,
    });

  const kind = preferSnapshotOverHeartbeat({
    heartbeatDue,
    snapshotDue,
    forceMergedSnapshot: !args.inHighFreqWindow,
    hasRaces: args.latestRaces.length > 0 || expected.length > 0,
  });
  if (kind === "odds_update") {
    const { races: completeRaces, meta: coverage } =
      await buildCompleteSnapshotRaces({
        env: args.env,
        meeting_date: args.meeting_date,
        venue: args.venue,
        expectedRaceNos: expected,
        available: args.latestRaces,
      });
    const sent = await emitOddsUpdateIfChanged({
      env: args.env,
      meeting_date: args.meeting_date,
      venue: args.venue,
      races: completeRaces,
      captured_at: args.captured_at,
      sample_interval_s: args.sample_interval_s,
      source_last_updated_at: args.source_last_updated_at,
      cachedHash: args.lastOddsUpdateHash,
      meta: {
        keepalive: true,
        merged_heartbeat: true,
        raceday_high_freq: args.inHighFreqWindow,
        heartbeat_interval_sec: Math.round(hbMs / 1000),
        ...coverage,
      },
    });
    if (sent.emitted) {
      return {
        emitted: "odds_update",
        lastFullByRace: markFullSnapshots(
          args.lastFullByRace,
          completeRaces,
          args.nowMs,
        ),
        heartbeatIntervalMs: hbMs,
        lastOddsUpdateHash: sent.hash,
      };
    }
    // Content unchanged since last push — fall through to no_update keepalive.
  }

  if (kind === "no_update" || kind === "odds_update") {
    const last = await getLastChange(
      args.env,
      args.meeting_date,
      args.venue,
    );
    await emitPush(args.env, {
      event: "no_update",
      meeting_date: args.meeting_date,
      venue: args.venue,
      races: [],
      captured_at: args.captured_at,
      sample_interval_s: args.sample_interval_s,
      source_last_updated_at: args.source_last_updated_at,
      last_change_seq: last.last_change_seq,
      last_change_at: last.last_change_at,
      meta: {
        raceday_high_freq: args.inHighFreqWindow,
        heartbeat_interval_sec: Math.round(hbMs / 1000),
        skipped_duplicate_snapshot: kind === "odds_update",
      },
    });
    return {
      emitted: "no_update",
      lastFullByRace: args.lastFullByRace,
      heartbeatIntervalMs: hbMs,
      lastOddsUpdateHash: args.lastOddsUpdateHash ?? null,
    };
  }

  return {
    emitted: null,
    lastFullByRace: args.lastFullByRace,
    heartbeatIntervalMs: hbMs,
    lastOddsUpdateHash: args.lastOddsUpdateHash ?? null,
  };
}

// Re-export for callers that still import apply helpers from here.
export { applyEmittedChangesToLastPushed, filterChangesAgainstLastPushed };
