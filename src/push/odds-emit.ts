import type { Env } from "../env";
import type { RaceOddsSnapshot } from "../parse/odds";
import { buildPoolInvestments } from "./delta";
import { emitPush } from "./emit";
import type { OddsDeltaChange, PushRace } from "./envelope";
import type { PmPoolRaw } from "../graphql/types";
import {
  appendCoalesceBatch,
  coalesceWindowElapsed,
  flattenCoalesceBuffer,
  preferSnapshotOverHeartbeat,
  pushCoalesceMs,
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
): Promise<CoalesceBuffer> {
  const seq = await allocatePushSeq(env, args.meeting_date, args.venue);
  const batch: CoalesceBatch = {
    captured_at: args.captured_at,
    sample_interval_s: args.sample_interval_s,
    seq,
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
): Promise<void> {
  const flat = flattenCoalesceBuffer(buffer);
  if (flat.changes.length === 0) return;
  await emitPush(env, {
    event: "odds_delta",
    meeting_date: args.meeting_date,
    venue: args.venue,
    races: flat.races,
    changes: flat.changes,
    pools: buildPoolInvestments(args.poolInvs, flat.race_nos),
    captured_at: flat.captured_at,
    sample_interval_s: flat.sample_interval_s,
    source_last_updated_at: flat.source_last_updated_at,
    meta:
      buffer.batches.length > 1
        ? {
            coalesced_batches: buffer.batches.length,
            covered_seq_from: flat.covered_seq_from,
            covered_seq_to: flat.covered_seq_to,
          }
        : undefined,
  });
}

/**
 * Flush when the coalesce window has elapsed, or coalesceMs is 0 (immediate).
 * Returns the remaining buffer (null if flushed).
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
  },
): Promise<{ buffer: CoalesceBuffer | null; flushed: boolean }> {
  if (!buffer || buffer.batches.length === 0) {
    return { buffer: null, flushed: false };
  }
  const coalesceMs = pushCoalesceMs(env);
  const due =
    args.force === true ||
    coalesceMs <= 0 ||
    coalesceWindowElapsed(buffer, args.nowMs, coalesceMs);
  if (!due) return { buffer, flushed: false };
  await flushOddsDeltaCoalesce(env, buffer, args);
  return { buffer: null, flushed: true };
}

/**
 * Idle keepalive: prefer a single odds_update when a periodic full snapshot
 * is due in the same heartbeat window; otherwise no_update.
 *
 * Outside the race-day high-freq window, always merge heartbeat + full
 * snapshot (receiver answers once per OFFDAY_HEARTBEAT_INTERVAL_SEC).
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
}): Promise<{
  emitted: "odds_update" | "no_update" | null;
  lastFullByRace: FullSnapshotByRace;
  heartbeatIntervalMs: number;
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
    await emitPush(args.env, {
      event: "odds_update",
      meeting_date: args.meeting_date,
      venue: args.venue,
      races: completeRaces,
      captured_at: args.captured_at,
      sample_interval_s: args.sample_interval_s,
      source_last_updated_at: args.source_last_updated_at,
      meta: {
        keepalive: true,
        merged_heartbeat: true,
        raceday_high_freq: args.inHighFreqWindow,
        heartbeat_interval_sec: Math.round(hbMs / 1000),
        ...coverage,
      },
    });
    return {
      emitted: "odds_update",
      lastFullByRace: markFullSnapshots(
        args.lastFullByRace,
        completeRaces,
        args.nowMs,
      ),
      heartbeatIntervalMs: hbMs,
    };
  }

  if (kind === "no_update") {
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
      },
    });
    return {
      emitted: "no_update",
      lastFullByRace: args.lastFullByRace,
      heartbeatIntervalMs: hbMs,
    };
  }

  return {
    emitted: null,
    lastFullByRace: args.lastFullByRace,
    heartbeatIntervalMs: hbMs,
  };
}
