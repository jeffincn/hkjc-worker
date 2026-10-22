import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ODDS_BASIS, type OddsDeltaChange, type PushRace } from "../src/push/envelope";
import {
  enqueueOddsDeltaBatch,
  filterDeltaForPush,
  flushOddsDeltaCoalesce,
  maybeFlushOddsDeltaCoalesce,
} from "../src/push/odds-emit";
import { allocatePushSeq } from "../src/push/seq";
import { saveLastPushedOdds } from "../src/push/dedupe";
import type { CoalesceBuffer } from "../src/push/odds-policy";

async function clearPushState(): Promise<void> {
  for (const t of [
    "push_subscribers",
    "pending_pushes",
    "push_log",
    "push_events",
    "push_seq",
    "worker_meta",
  ]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

function change(raceNo: number, odds = 5): OddsDeltaChange {
  return {
    race_no: raceNo,
    runner_no: raceNo,
    runner_id: `no:${raceNo}`,
    horse_no: raceNo,
    horse_name_en: `H${raceNo}`,
    horse_name_ch: null,
    status: "Declared",
    bet_type: "WIN",
    odds_basis: ODDS_BASIS,
    prev_odds: odds,
    new_odds: odds + 1,
    source_last_updated_at: null,
    race_post_time: null,
    pool_status: "START_SELL",
  };
}

function race(raceNo: number): PushRace {
  return {
    race_no: raceNo,
    post_time: null,
    snapshot_time: "2026-10-21T18:00:00+08:00",
    pool_status: "START_SELL",
    runners: [],
  };
}

describe("allocatePushSeq atomic", () => {
  beforeEach(async () => {
    await clearPushState();
  });

  it("allocates monotonic seq without duplicates under concurrent callers", async () => {
    const n = 40;
    const got = await Promise.all(
      Array.from({ length: n }, () => allocatePushSeq(env, "2026-10-21", "HV")),
    );
    const sorted = [...got].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(new Set(got).size).toBe(n);
  });

  it("keeps independent counters per meeting", async () => {
    const a = await allocatePushSeq(env, "2026-10-21", "HV");
    const b = await allocatePushSeq(env, "2026-10-21", "ST");
    const c = await allocatePushSeq(env, "2026-10-21", "HV");
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(2);
  });
});

describe("odds_delta coalesce seq + max-age", () => {
  beforeEach(async () => {
    await clearPushState();
  });

  it("enqueue does not burn seq; flush allocates once (merge 无缺号)", async () => {
    let buf: CoalesceBuffer | null = null;
    buf = await enqueueOddsDeltaBatch(env, buf, {
      meeting_date: "2026-10-21",
      venue: "HV",
      nowMs: 1_000,
      captured_at: "2026-10-21T18:00:00+08:00",
      sample_interval_s: 3,
      changes: [change(1)],
      races: [race(1)],
      race_nos: [1],
      source_last_updated_at: null,
    });
    buf = await enqueueOddsDeltaBatch(env, buf, {
      meeting_date: "2026-10-21",
      venue: "HV",
      nowMs: 2_000,
      captured_at: "2026-10-21T18:00:01+08:00",
      sample_interval_s: 3,
      changes: [change(2)],
      races: [race(2)],
      race_nos: [2],
      source_last_updated_at: null,
    });
    expect(buf?.batches).toHaveLength(2);
    // No provisional seq allocation while buffering.
    const seqRow = await env.DB.prepare(
      `SELECT next_seq FROM push_seq WHERE meeting_date=? AND venue=?`,
    )
      .bind("2026-10-21", "HV")
      .first<{ next_seq: number }>();
    expect(seqRow).toBeNull();

    const ok = await flushOddsDeltaCoalesce(env, buf!, {
      meeting_date: "2026-10-21",
      venue: "HV",
      poolInvs: [],
    });
    expect(ok).toBe(true);

    const after = await env.DB.prepare(
      `SELECT next_seq FROM push_seq WHERE meeting_date=? AND venue=?`,
    )
      .bind("2026-10-21", "HV")
      .first<{ next_seq: number }>();
    expect(after?.next_seq).toBe(1);

    const events = await env.DB.prepare(
      `SELECT seq, event_type, payload_json FROM push_events
       WHERE meeting_date=? AND venue=? ORDER BY seq`,
    )
      .bind("2026-10-21", "HV")
      .all<{ seq: number; event_type: string; payload_json: string }>();
    expect(events.results).toHaveLength(1);
    expect(events.results![0]!.seq).toBe(1);
    expect(events.results![0]!.event_type).toBe("odds_delta");
    const payload = JSON.parse(events.results![0]!.payload_json) as {
      seq: number;
      changes: Array<{ race_no: number; seq: number; captured_at: string }>;
      meta?: { coalesced_batches?: number; covered_seq_from?: number; covered_seq_to?: number };
    };
    expect(payload.seq).toBe(1);
    expect(payload.changes).toHaveLength(2);
    expect(payload.changes.every((c) => c.seq === 1)).toBe(true);
    expect(payload.changes.map((c) => c.captured_at)).toEqual([
      "2026-10-21T18:00:00+08:00",
      "2026-10-21T18:00:01+08:00",
    ]);
    expect(payload.meta).toMatchObject({
      coalesced_batches: 2,
      covered_seq_from: 1,
      covered_seq_to: 1,
    });

    // Next independent event continues without a gap.
    const next = await allocatePushSeq(env, "2026-10-21", "HV");
    expect(next).toBe(2);
  });

  it("does not allocate seq when flush filter leaves nothing", async () => {
    // Seed last-pushed so the buffered change is considered unchanged.
    await saveLastPushedOdds(env, "2026-10-21", "HV", {
      "no:1|WIN": 6,
    });

    let buf: CoalesceBuffer | null = null;
    buf = await enqueueOddsDeltaBatch(env, buf, {
      meeting_date: "2026-10-21",
      venue: "HV",
      nowMs: 1_000,
      captured_at: "2026-10-21T18:00:00+08:00",
      sample_interval_s: 3,
      // new_odds = prev+1 = 6 when prev is 5 → matches last pushed 6
      changes: [change(1, 5)],
      races: [race(1)],
      race_nos: [1],
      source_last_updated_at: null,
    });

    // Confirm filter would drop it.
    const gated = await filterDeltaForPush(env, "2026-10-21", "HV", [
      change(1, 5),
    ]);
    expect(gated).toBeNull();

    const ok = await flushOddsDeltaCoalesce(env, buf!, {
      meeting_date: "2026-10-21",
      venue: "HV",
      poolInvs: [],
    });
    expect(ok).toBe(false);

    const seqRow = await env.DB.prepare(
      `SELECT next_seq FROM push_seq WHERE meeting_date=? AND venue=?`,
    )
      .bind("2026-10-21", "HV")
      .first<{ next_seq: number }>();
    expect(seqRow).toBeNull();

    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM push_events WHERE meeting_date=? AND venue=?`,
    )
      .bind("2026-10-21", "HV")
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("force-flushes when oldest captured_at exceeds max age (even if coalesce window open)", async () => {
    const t0 = Date.parse("2026-10-21T18:00:00+08:00");
    let buf: CoalesceBuffer | null = null;
    buf = await enqueueOddsDeltaBatch(env, buf, {
      meeting_date: "2026-10-21",
      venue: "HV",
      nowMs: t0,
      captured_at: "2026-10-21T18:00:00+08:00",
      sample_interval_s: 3,
      changes: [change(1)],
      races: [race(1)],
      race_nos: [1],
      source_last_updated_at: null,
    });

    // Off-window-style 300s coalesce not elapsed; max-age 20s is.
    const early = await maybeFlushOddsDeltaCoalesce(env, buf, {
      meeting_date: "2026-10-21",
      venue: "HV",
      poolInvs: [],
      nowMs: t0 + 19_000,
      inHighFreqWindow: false,
      coalesceMs: 300_000,
      maxAgeSec: 20,
    });
    expect(early.flushed).toBe(false);
    expect(early.buffer).not.toBeNull();

    const late = await maybeFlushOddsDeltaCoalesce(env, early.buffer, {
      meeting_date: "2026-10-21",
      venue: "HV",
      poolInvs: [],
      nowMs: t0 + 20_000,
      inHighFreqWindow: false,
      coalesceMs: 300_000,
      maxAgeSec: 20,
    });
    expect(late.flushed).toBe(true);
    expect(late.buffer).toBeNull();

    const after = await env.DB.prepare(
      `SELECT next_seq FROM push_seq WHERE meeting_date=? AND venue=?`,
    )
      .bind("2026-10-21", "HV")
      .first<{ next_seq: number }>();
    expect(after?.next_seq).toBe(1);
  });
});
