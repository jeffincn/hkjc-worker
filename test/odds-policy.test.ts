import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type { RaceOddsSnapshot } from "../src/parse/odds";
import {
  appendCoalesceBatch,
  coalesceWindowElapsed,
  DEFAULT_HEARTBEAT_INTERVAL_SEC,
  DEFAULT_OFFDAY_HEARTBEAT_INTERVAL_SEC,
  DEFAULT_RACEDAY_WINDOW_BEFORE_SEC,
  finalRaceNo,
  firstRacePostMs,
  flattenCoalesceBuffer,
  isInRaceDayHighFreqWindow,
  preferSnapshotOverHeartbeat,
  resolveEffectiveHeartbeatIntervalMs,
  shouldEmitHeartbeat,
  shouldPushFullSnapshot,
  type CoalesceBatch,
} from "../src/push/odds-policy";
import type { OddsDeltaChange, PushRace } from "../src/push/envelope";
import { ODDS_BASIS } from "../src/push/envelope";

function env(vars: Record<string, string> = {}): Env {
  return vars as unknown as Env;
}

function snap(partial: Partial<RaceOddsSnapshot> & { race_no: number }): RaceOddsSnapshot {
  const pool_status = partial.pool_status ?? "START_SELL";
  return {
    race_no: partial.race_no,
    post_time: partial.post_time ?? "2026-10-07T20:00:00+08:00",
    snapshot_time: partial.snapshot_time ?? "2026-10-07T19:00:00+08:00",
    pool_status,
    runners: partial.runners ?? [],
    payload: partial.payload ?? {
      race_no: partial.race_no,
      pool_status,
      win: {},
      pla: {},
      last_update: "2026-10-07T19:00:00+08:00",
    },
  };
}

function change(race_no = 1): OddsDeltaChange {
  return {
    race_no,
    runner_no: 1,
    horse_name_ch: null,
    horse_name_en: "A",
    bet_type: "WIN",
    odds_basis: ODDS_BASIS,
    prev_odds: 4,
    new_odds: 3.5,
    source_last_updated_at: null,
    race_post_time: null,
    pool_status: "START_SELL",
  };
}

function pushRace(race_no: number): PushRace {
  return {
    race_no,
    post_time: null,
    snapshot_time: "2026-10-07T19:00:00+08:00",
    pool_status: "START_SELL",
    runners: [],
  };
}

describe("shouldPushFullSnapshot", () => {
  const interval = 300;
  const now = 1_000_000;

  it("pushes on first observation", () => {
    expect(
      shouldPushFullSnapshot({
        previous: null,
        next: snap({ race_no: 1 }),
        lastFullSnapshotAtMs: null,
        nowMs: now,
        fullSnapshotIntervalSec: interval,
      }),
    ).toBe(true);
  });

  it("pushes when pool_status changes", () => {
    expect(
      shouldPushFullSnapshot({
        previous: snap({ race_no: 1, pool_status: "START_SELL" }),
        next: snap({ race_no: 1, pool_status: "STOP_SELL" }),
        lastFullSnapshotAtMs: now - 1000,
        nowMs: now,
        fullSnapshotIntervalSec: interval,
      }),
    ).toBe(true);
  });

  it("skips when only odds changed inside interval", () => {
    expect(
      shouldPushFullSnapshot({
        previous: snap({ race_no: 1, pool_status: "START_SELL" }),
        next: snap({ race_no: 1, pool_status: "START_SELL" }),
        lastFullSnapshotAtMs: now - 60_000,
        nowMs: now,
        fullSnapshotIntervalSec: interval,
      }),
    ).toBe(false);
  });

  it("pushes when interval elapsed", () => {
    expect(
      shouldPushFullSnapshot({
        previous: snap({ race_no: 1 }),
        next: snap({ race_no: 1 }),
        lastFullSnapshotAtMs: now - 300_000,
        nowMs: now,
        fullSnapshotIntervalSec: interval,
      }),
    ).toBe(true);
  });
});

describe("live coalesce buffer", () => {
  it("merges batches with per-change captured_at/seq/sample_interval_s", () => {
    const b1: CoalesceBatch = {
      captured_at: "2026-10-07T19:00:00+08:00",
      sample_interval_s: 3,
      seq: 10,
      changes: [change(1)],
      races: [pushRace(1)],
      race_nos: [1],
      source_last_updated_at: "2026-10-07T19:00:00+08:00",
    };
    const b2: CoalesceBatch = {
      captured_at: "2026-10-07T19:00:02+08:00",
      sample_interval_s: 3,
      seq: 11,
      changes: [change(2)],
      races: [pushRace(2)],
      race_nos: [2],
      source_last_updated_at: "2026-10-07T19:00:02+08:00",
    };
    let buf = appendCoalesceBatch(null, b1, 1000);
    buf = appendCoalesceBatch(buf, b2, 2500);
    // Window opens at 1000; elapsed only after opened_at + coalesceMs.
    expect(coalesceWindowElapsed(buf, 2999, 2000)).toBe(false);
    expect(coalesceWindowElapsed(buf, 3000, 2000)).toBe(true);

    const flat = flattenCoalesceBuffer(buf);
    expect(flat.changes).toHaveLength(2);
    expect(flat.changes[0]).toMatchObject({
      race_no: 1,
      seq: 10,
      captured_at: "2026-10-07T19:00:00+08:00",
      sample_interval_s: 3,
    });
    expect(flat.changes[1]).toMatchObject({
      race_no: 2,
      seq: 11,
      captured_at: "2026-10-07T19:00:02+08:00",
      sample_interval_s: 3,
    });
    expect(flat.covered_seq_from).toBe(10);
    expect(flat.covered_seq_to).toBe(11);
    expect(flat.race_nos).toEqual([1, 2]);
  });
});

describe("race-day high-freq window boundaries", () => {
  const firstPost = Date.parse("2026-10-07T20:00:00+08:00");
  const before = DEFAULT_RACEDAY_WINDOW_BEFORE_SEC; // 7200

  it("is closed more than 2h before first post", () => {
    expect(
      isInRaceDayHighFreqWindow({
        nowMs: firstPost - before * 1000 - 1,
        firstPostMs: firstPost,
        finalDividendsPublished: false,
        windowBeforeSec: before,
      }),
    ).toBe(false);
  });

  it("opens exactly at first_post - RACEDAY_WINDOW_BEFORE_SEC", () => {
    expect(
      isInRaceDayHighFreqWindow({
        nowMs: firstPost - before * 1000,
        firstPostMs: firstPost,
        finalDividendsPublished: false,
        windowBeforeSec: before,
      }),
    ).toBe(true);
  });

  it("stays open through raceday until dividends", () => {
    expect(
      isInRaceDayHighFreqWindow({
        nowMs: firstPost + 3 * 3600_000,
        firstPostMs: firstPost,
        finalDividendsPublished: false,
        windowBeforeSec: before,
      }),
    ).toBe(true);
  });

  it("closes once final race dividends are published", () => {
    expect(
      isInRaceDayHighFreqWindow({
        nowMs: firstPost + 3 * 3600_000,
        firstPostMs: firstPost,
        finalDividendsPublished: true,
        windowBeforeSec: before,
      }),
    ).toBe(false);
  });

  it("is closed when first post is unknown", () => {
    expect(
      isInRaceDayHighFreqWindow({
        nowMs: firstPost,
        firstPostMs: null,
        finalDividendsPublished: false,
        windowBeforeSec: before,
      }),
    ).toBe(false);
  });

  it("firstRacePostMs / finalRaceNo helpers", () => {
    expect(
      firstRacePostMs([
        { post_time: "2026-10-07T21:00:00+08:00" },
        { post_time: "2026-10-07T19:15:00+08:00" },
        { post_time: null },
      ]),
    ).toBe(Date.parse("2026-10-07T19:15:00+08:00"));
    expect(finalRaceNo([{ race_no: 1 }, { race_no: 11 }, { race_no: 5 }])).toBe(11);
    expect(finalRaceNo([])).toBe(null);
  });
});

describe("effective heartbeat interval (raceday vs offday)", () => {
  it("uses HEARTBEAT_INTERVAL_SEC inside high-freq window", () => {
    const e = env({ HEARTBEAT_INTERVAL_SEC: "300", OFFDAY_HEARTBEAT_INTERVAL_SEC: "1800" });
    expect(resolveEffectiveHeartbeatIntervalMs(e, true)).toBe(
      DEFAULT_HEARTBEAT_INTERVAL_SEC * 1000,
    );
  });

  it("uses OFFDAY_HEARTBEAT_INTERVAL_SEC outside window", () => {
    const e = env({ HEARTBEAT_INTERVAL_SEC: "300", OFFDAY_HEARTBEAT_INTERVAL_SEC: "1800" });
    expect(resolveEffectiveHeartbeatIntervalMs(e, false)).toBe(
      DEFAULT_OFFDAY_HEARTBEAT_INTERVAL_SEC * 1000,
    );
  });

  it("gates on last any push", () => {
    const now = 10_000_000;
    expect(
      shouldEmitHeartbeat({
        nowMs: now,
        lastAnyPushAtMs: now - 299_000,
        heartbeatIntervalMs: 300_000,
      }),
    ).toBe(false);
    expect(
      shouldEmitHeartbeat({
        nowMs: now,
        lastAnyPushAtMs: now - 300_000,
        heartbeatIntervalMs: 300_000,
      }),
    ).toBe(true);
    expect(
      shouldEmitHeartbeat({
        nowMs: now,
        lastAnyPushAtMs: now - 1_799_000,
        heartbeatIntervalMs: 1_800_000,
      }),
    ).toBe(false);
    expect(
      shouldEmitHeartbeat({
        nowMs: now,
        lastAnyPushAtMs: now - 1_800_000,
        heartbeatIntervalMs: 1_800_000,
      }),
    ).toBe(true);
  });
});

describe("preferSnapshotOverHeartbeat merge", () => {
  it("merges to odds_update when snapshot due with heartbeat", () => {
    expect(
      preferSnapshotOverHeartbeat({ heartbeatDue: true, snapshotDue: true }),
    ).toBe("odds_update");
  });

  it("emits no_update when only heartbeat due inside raceday", () => {
    expect(
      preferSnapshotOverHeartbeat({ heartbeatDue: true, snapshotDue: false }),
    ).toBe("no_update");
  });

  it("outside window always merges heartbeat with full snapshot", () => {
    expect(
      preferSnapshotOverHeartbeat({
        heartbeatDue: true,
        snapshotDue: false,
        forceMergedSnapshot: true,
        hasRaces: true,
      }),
    ).toBe("odds_update");
  });

  it("outside window falls back to no_update without races", () => {
    expect(
      preferSnapshotOverHeartbeat({
        heartbeatDue: true,
        snapshotDue: false,
        forceMergedSnapshot: true,
        hasRaces: false,
      }),
    ).toBe("no_update");
  });
});
