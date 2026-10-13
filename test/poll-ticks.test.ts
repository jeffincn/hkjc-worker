import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import {
  COLLECTION_FAILURE,
  POLL_GAP_ALERT_SIG_KEY,
  POLL_GAP_META_KEY,
  POLL_GAP_THRESHOLD_MS,
  answerCoverageForRange,
  buildCoverageIntervals,
  detectGapsForRace,
  evaluateAndAlertCoverageGaps,
  gapAlertSignature,
  recordPollTicks,
  type PollTickRow,
} from "../src/store/poll-ticks";
import { isLivePushEvent } from "../src/push/envelope";

describe("poll_ticks helpers (R1b)", () => {
  it("detects COLLECTION_FAILURE gaps > 10 min between ticks and trailing to now", () => {
    const ticks = [
      { tick_time: "2026-10-13T10:00:00.000Z" },
      { tick_time: "2026-10-13T10:05:00.000Z" },
      { tick_time: "2026-10-13T10:25:00.000Z" },
    ];
    const gaps = detectGapsForRace({
      race_no: 1,
      ticks,
      nowMs: Date.parse("2026-10-13T10:40:00.000Z"),
    });
    expect(gaps).toHaveLength(2);
    expect(gaps.every((g) => g.kind === COLLECTION_FAILURE)).toBe(true);
    expect(gaps[0]!.gap_ms).toBe(20 * 60 * 1000);
    expect(gaps[0]!.from).toBe("2026-10-13T10:05:00.000Z");
    expect(gaps[1]!.gap_ms).toBe(15 * 60 * 1000);
  });

  it("classifies intervals as STATIC vs MISSING (A2)", () => {
    const ticks: PollTickRow[] = [
      {
        meeting_date: "2026-10-13",
        venue: "ST",
        race_no: 1,
        tick_time: "2026-10-13T10:00:30.000Z",
        changed: 0,
      },
      {
        meeting_date: "2026-10-13",
        venue: "ST",
        race_no: 1,
        tick_time: "2026-10-13T10:01:30.000Z",
        changed: 0,
      },
      {
        meeting_date: "2026-10-13",
        venue: "ST",
        race_no: 1,
        tick_time: "2026-10-13T10:02:10.000Z",
        changed: 1,
      },
      {
        meeting_date: "2026-10-13",
        venue: "ST",
        race_no: 1,
        tick_time: "2026-10-13T10:20:00.000Z",
        changed: 0,
      },
    ];
    const intervals = buildCoverageIntervals({ ticks });
    expect(intervals.map((i) => i.kind)).toEqual([
      "STATIC",
      "STATIC",
      "MISSING",
    ]);
    expect(intervals[1]!.changed).toBe(true);
    expect(intervals[2]!.gap_ms).toBeGreaterThan(POLL_GAP_THRESHOLD_MS);
  });

  it("answers STATIC vs MISSING for any (race, time_range)", () => {
    const ticks: PollTickRow[] = [
      {
        meeting_date: "2026-10-13",
        venue: "ST",
        race_no: 3,
        tick_time: "2026-10-13T12:00:00.000Z",
        changed: 0,
      },
      {
        meeting_date: "2026-10-13",
        venue: "ST",
        race_no: 3,
        tick_time: "2026-10-13T12:03:00.000Z",
        changed: 0,
      },
      {
        meeting_date: "2026-10-13",
        venue: "ST",
        race_no: 3,
        tick_time: "2026-10-13T12:06:00.000Z",
        changed: 1,
      },
    ];
    const staticAns = answerCoverageForRange({
      ticks,
      from: "2026-10-13T12:00:00.000Z",
      to: "2026-10-13T12:06:00.000Z",
    });
    expect(staticAns.kind).toBe("STATIC");

    const missingAns = answerCoverageForRange({
      ticks: [
        ...ticks,
        {
          meeting_date: "2026-10-13",
          venue: "ST",
          race_no: 3,
          tick_time: "2026-10-13T12:30:00.000Z",
          changed: 0,
        },
      ],
      from: "2026-10-13T12:00:00.000Z",
      to: "2026-10-13T12:30:00.000Z",
    });
    expect(missingAns.kind).toBe("MISSING");
  });

  it("odds_coverage_gap is not LIVE_PUSH-gated", () => {
    expect(isLivePushEvent("odds_coverage_gap")).toBe(false);
    expect(isLivePushEvent("source_blocked")).toBe(false);
  });
});

describe("recordPollTicks + coverage API (no compaction)", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM poll_ticks`).run();
    await env.DB.prepare(
      `DELETE FROM worker_meta WHERE key IN (?, ?)`,
    )
      .bind(POLL_GAP_META_KEY, POLL_GAP_ALERT_SIG_KEY)
      .run();
  });

  it("writes one row per poll per race (C1: no minute merge)", async () => {
    const n1 = await recordPollTicks(env, "2026-10-13", "ST", [
      {
        race_no: 1,
        changed: false,
        tick_time: "2026-10-13T12:34:10.000Z",
      },
    ]);
    expect(n1).toBe(1);
    const n2 = await recordPollTicks(env, "2026-10-13", "ST", [
      {
        race_no: 1,
        changed: true,
        tick_time: "2026-10-13T12:34:50.000Z",
      },
    ]);
    expect(n2).toBe(1);

    const { results } = await env.DB.prepare(
      `SELECT tick_time, changed FROM poll_ticks
       WHERE meeting_date=? AND venue=? AND race_no=?
       ORDER BY tick_time ASC`,
    )
      .bind("2026-10-13", "ST", 1)
      .all<{ tick_time: string; changed: number }>();
    expect(results).toHaveLength(2);
    expect(results![0]!.tick_time).toBe("2026-10-13T12:34:10.000Z");
    expect(results![0]!.changed).toBe(0);
    expect(results![1]!.tick_time).toBe("2026-10-13T12:34:50.000Z");
    expect(results![1]!.changed).toBe(1);
  });

  it("exposes STATIC/MISSING on /v1/odds/history (with time_range) and /v1/odds/coverage", async () => {
    await recordPollTicks(env, "2026-10-13", "HV", [
      { race_no: 2, changed: false, tick_time: "2026-10-13T08:00:00.000Z" },
      { race_no: 2, changed: true, tick_time: "2026-10-13T08:01:00.000Z" },
      { race_no: 2, changed: false, tick_time: "2026-10-13T08:20:00.000Z" },
    ]);

    const token = "test-api-token";
    const ctx = createExecutionContext();
    const hist = await worker.fetch(
      new Request(
        "http://localhost/v1/odds/history?date=2026-10-13&venue=HV&race_no=2" +
          "&from=2026-10-13T08:00:00.000Z&to=2026-10-13T08:20:00.000Z",
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(hist.status).toBe(200);
    const histBody = (await hist.json()) as {
      coverage: {
        gaps: Array<{ kind: string; gap_ms: number }>;
        intervals: Array<{ kind: string }>;
        tick_count: number;
        range: { kind: string; from: string; to: string } | null;
      };
    };
    expect(histBody.coverage.tick_count).toBe(3);
    expect(histBody.coverage.gaps.every((g) => g.kind === COLLECTION_FAILURE)).toBe(
      true,
    );
    expect(histBody.coverage.intervals.some((i) => i.kind === "MISSING")).toBe(
      true,
    );
    expect(histBody.coverage.range?.kind).toBe("MISSING");

    const ctx2 = createExecutionContext();
    const cov = await worker.fetch(
      new Request(
        "http://localhost/v1/odds/coverage?date=2026-10-13&venue=HV&race_no=2",
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    expect(cov.status).toBe(200);
    const covBody = (await cov.json()) as {
      gaps: Array<{ kind: string }>;
      intervals: Array<{ kind: string }>;
      ticks: unknown[];
    };
    expect(covBody.ticks).toHaveLength(3);
    expect(covBody.gaps.length).toBeGreaterThanOrEqual(1);
  });

  it("emits odds_coverage_gap once per signature and surfaces COLLECTION_FAILURE in /health", async () => {
    await recordPollTicks(env, "2026-10-13", "ST", [
      { race_no: 1, changed: false, tick_time: "2026-10-13T09:00:00.000Z" },
      { race_no: 1, changed: false, tick_time: "2026-10-13T09:20:00.000Z" },
    ]);

    const emitted: string[] = [];
    const emit = async (_env: Env, args: { event: string }) => {
      emitted.push(args.event);
      return {
        envelope: { event: args.event } as never,
        result: {
          skipped: true,
          reason: "test",
          http_status: null,
          success: false,
          retry_count: 0,
        },
      };
    };

    const state1 = await evaluateAndAlertCoverageGaps(env, {
      meeting_date: "2026-10-13",
      venue: "ST",
      race_nos: [1],
      captured_at: "2026-10-13T17:20:00+08:00",
      sample_interval_s: 3,
      nowMs: Date.parse("2026-10-13T09:20:30.000Z"),
      emit: emit as never,
    });
    expect(state1?.status).toBe(COLLECTION_FAILURE);
    expect(state1?.gaps.length).toBeGreaterThanOrEqual(1);
    expect(emitted).toEqual(["odds_coverage_gap"]);

    await evaluateAndAlertCoverageGaps(env, {
      meeting_date: "2026-10-13",
      venue: "ST",
      race_nos: [1],
      captured_at: "2026-10-13T17:21:00+08:00",
      sample_interval_s: 3,
      nowMs: Date.parse("2026-10-13T09:20:30.000Z"),
      emit: emit as never,
    });
    expect(emitted).toEqual(["odds_coverage_gap"]);

    const meta = await env.DB.prepare(
      `SELECT value FROM worker_meta WHERE key=?`,
    )
      .bind(POLL_GAP_META_KEY)
      .first<{ value: string }>();
    const parsed = JSON.parse(meta!.value) as {
      signature: string;
      status: string;
      gaps: unknown[];
    };
    expect(parsed.status).toBe(COLLECTION_FAILURE);
    expect(parsed.gaps.length).toBeGreaterThanOrEqual(1);
    expect(parsed.signature).toBe(gapAlertSignature(state1!.gaps));

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/health"), env, ctx);
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      gaps: { odds_coverage: { status: string; gaps: unknown[] } | null };
      alerts: { odds_coverage_gap: { status: string; gaps: unknown[] } | null };
    };
    expect(body.gaps.odds_coverage?.status).toBe(COLLECTION_FAILURE);
    expect(body.alerts.odds_coverage_gap?.gaps?.length).toBeGreaterThanOrEqual(1);
  });
});
