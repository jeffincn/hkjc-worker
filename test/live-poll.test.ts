import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { fetchGraphQL, looksLikeChallenge, SourceBlockedError } from "../src/graphql/client";
import { computePollIntervalMs } from "../src/poll/interval";
import {
  backoffIntervalMs,
  BACKOFF_CAP_MS,
  BUDGET_EXHAUSTED_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  effectiveIntervalMs,
  HEALTHY_BLOCK_STATE,
  hkDay,
  msUntilHkMidnight,
  nextBlockState,
  resolveDailyRequestBudget,
  resolvePollIntervalMs,
  throttleIntervalMs,
  type BlockState,
} from "../src/poll/live";
import { buildEnvelope } from "../src/push/envelope";
import { buildRaceOddsSnapshot } from "../src/parse/odds";
import { insertOddsSnapshotIfChanged, setMeta } from "../src/store/db";
import { addGraphqlUsage, getGraphqlUsage } from "../src/store/usage";

const e = (vars: Record<string, string>) => vars as unknown as Env;

describe("POLL_INTERVAL_MS", () => {
  it("defaults to 3000", () => {
    expect(resolvePollIntervalMs(e({}))).toBe(3000);
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(3000);
  });
  it("honours configured value and clamps", () => {
    expect(resolvePollIntervalMs(e({ POLL_INTERVAL_MS: "5000" }))).toBe(5000);
    expect(resolvePollIntervalMs(e({ POLL_INTERVAL_MS: "200" }))).toBe(1000);
    expect(resolvePollIntervalMs(e({ POLL_INTERVAL_MS: "99999999" }))).toBe(600_000);
    expect(resolvePollIntervalMs(e({ POLL_INTERVAL_MS: "abc" }))).toBe(3000);
    expect(resolvePollIntervalMs(e({ POLL_INTERVAL_MS: "-5" }))).toBe(3000);
  });
  it("ignores legacy POLL_INTERVAL_SEC", () => {
    expect(resolvePollIntervalMs(e({ POLL_INTERVAL_SEC: "10" }))).toBe(3000);
  });
  it("wrangler/miniflare env resolves to 3000", () => {
    expect(resolvePollIntervalMs(env as unknown as Env)).toBe(3000);
    expect(resolveDailyRequestBudget(env as unknown as Env)).toBe(30_000);
  });
});

describe("live interval schedule", () => {
  const now = Date.parse("2026-10-07T13:00:00+08:00");
  it("polls at live interval whenever betting is open, even hours before post", () => {
    expect(
      computePollIntervalMs({
        nowMs: now,
        postTimeIso: "2026-10-07T19:15:00+08:00",
        liveIntervalMs: 3000,
        bettingOpen: true,
      }),
    ).toBe(3000);
  });
  it("falls back to tiered schedule when betting not open", () => {
    expect(
      computePollIntervalMs({
        nowMs: now,
        postTimeIso: "2026-10-07T19:15:00+08:00",
        liveIntervalMs: 3000,
        bettingOpen: false,
      }),
    ).toBe(300_000);
  });
  it("uses live interval within 30 min of post", () => {
    expect(
      computePollIntervalMs({
        nowMs: now,
        postTimeIso: "2026-10-07T13:20:00+08:00",
        liveIntervalMs: 3000,
      }),
    ).toBe(3000);
  });
});

describe("HKT day helpers", () => {
  it("rolls over at HKT midnight (16:00Z)", () => {
    expect(hkDay(Date.parse("2026-10-11T15:59:59Z"))).toBe("2026-10-11");
    expect(hkDay(Date.parse("2026-10-11T16:00:00Z"))).toBe("2026-10-12");
    expect(msUntilHkMidnight(Date.parse("2026-10-11T15:00:00Z"))).toBe(3_600_000);
  });
});

describe("daily request budget throttle", () => {
  const now = Date.parse("2026-10-11T12:00:00+08:00");
  const base = { baseMs: 3000, budget: 30_000, nowMs: now };
  it("keeps 3s when projection fits", () => {
    // 6h * 1200 ticks/h * 2 = 14,400
    expect(
      throttleIntervalMs({ ...base, usedToday: 1000, horizonEndMs: now + 6 * 3_600_000 }),
    ).toBe(3000);
  });
  it("steps up to 5s then 10s as projection approaches budget", () => {
    // 3s for 6h needs 14,400; 5s needs 8,640; 10s needs 4,320
    expect(
      throttleIntervalMs({ ...base, usedToday: 20_000, horizonEndMs: now + 6 * 3_600_000 }),
    ).toBe(5000);
    expect(
      throttleIntervalMs({ ...base, usedToday: 24_000, horizonEndMs: now + 6 * 3_600_000 }),
    ).toBe(10_000);
  });
  it("uses exhausted interval at/over budget", () => {
    expect(throttleIntervalMs({ ...base, usedToday: 30_000 })).toBe(BUDGET_EXHAUSTED_INTERVAL_MS);
  });
  it("caps horizon at HKT midnight when no meeting end known", () => {
    const late = Date.parse("2026-10-11T23:50:00+08:00"); // 10 min left
    expect(
      throttleIntervalMs({ baseMs: 3000, budget: 30_000, usedToday: 29_500, nowMs: late }),
    ).toBe(3000); // 200 ticks*2=400 fits
  });
});

describe("source block backoff", () => {
  const iso = "2026-10-11T10:00:00.000Z";
  it("blocks immediately on 403/429/challenge and backs off exponentially to cap", () => {
    let s: BlockState = { ...HEALTHY_BLOCK_STATE };
    const t1 = nextBlockState(s, { kind: "blocked", reason: "http_429" }, iso);
    expect(t1.becameBlocked).toBe(true);
    s = t1.state;
    expect(backoffIntervalMs(3000, s)).toBe(6000);
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t = nextBlockState(s, { kind: "blocked", reason: "http_429" }, iso);
      expect(t.becameBlocked).toBe(false);
      s = t.state;
      seen.push(backoffIntervalMs(3000, s));
    }
    expect(seen).toEqual([12_000, 24_000, 48_000, 60_000, 60_000, 60_000]);
    expect(backoffIntervalMs(3000, s)).toBe(BACKOFF_CAP_MS);
  });
  it("needs 3 consecutive network errors before blocking", () => {
    let s: BlockState = { ...HEALTHY_BLOCK_STATE };
    for (let i = 0; i < 2; i++) {
      const t = nextBlockState(s, { kind: "error", reason: "ECONNRESET" }, iso);
      expect(t.state.blocked).toBe(false);
      s = t.state;
    }
    expect(backoffIntervalMs(3000, s)).toBe(3000);
    const t = nextBlockState(s, { kind: "error", reason: "ECONNRESET" }, iso);
    expect(t.becameBlocked).toBe(true);
  });
  it("clears source_block immediately on successful fetch (incl. misclassified D1)", () => {
    let s: BlockState = { ...HEALTHY_BLOCK_STATE };
    for (let i = 0; i < 3; i++) s = nextBlockState(s, { kind: "blocked", reason: "http_403" }, iso).state;
    expect(s.blocked).toBe(true);
    expect(backoffIntervalMs(3000, s)).toBe(24_000);
    const t = nextBlockState(s, { kind: "ok" }, iso);
    expect(t.recovered).toBe(true);
    expect(t.state).toEqual(HEALTHY_BLOCK_STATE);
    expect(backoffIntervalMs(3000, t.state)).toBe(3000);
  });
  it("storage/D1 errors never open or extend source_block", () => {
    let s: BlockState = { ...HEALTHY_BLOCK_STATE };
    const t1 = nextBlockState(
      s,
      { kind: "storage", reason: "D1 free tier daily row write limit exceeded" },
      iso,
    );
    expect(t1.state.blocked).toBe(false);
    expect(t1.becameBlocked).toBe(false);
    expect(t1.state).toEqual(HEALTHY_BLOCK_STATE);

    // Even while already blocked for HKJC reasons, storage does not change state.
    s = nextBlockState(s, { kind: "blocked", reason: "http_429" }, iso).state;
    const prev = { ...s };
    const t2 = nextBlockState(s, { kind: "storage", reason: "D1_TYPE_ERROR" }, iso);
    expect(t2.state).toEqual(prev);
    expect(t2.becameBlocked).toBe(false);
    expect(t2.recovered).toBe(false);

    // After a D1-misclassified legacy block, success clears immediately.
    const legacy: BlockState = {
      blocked: true,
      level: 2,
      consecutive_failures: 5,
      reason: "D1 free tier daily row write limit",
      since: iso,
      last_error_at: iso,
    };
    const cleared = nextBlockState(legacy, { kind: "ok" }, iso);
    expect(cleared.recovered).toBe(true);
    expect(cleared.state).toEqual(HEALTHY_BLOCK_STATE);
  });
  it("effective interval is the max of schedule/throttle/backoff", () => {
    expect(effectiveIntervalMs({ scheduleMs: 3000, throttleMs: 5000, backoffMs: 12_000 })).toBe(
      12_000,
    );
    expect(effectiveIntervalMs({ scheduleMs: 300_000, throttleMs: 3000, backoffMs: 6000 })).toBe(
      300_000,
    );
  });
});

describe("GraphQL client block detection", () => {
  const mk = (status: number, body: string, ct = "application/json") =>
    (async () => new Response(body, { status, headers: { "content-type": ct } })) as unknown as typeof fetch;

  it("throws SourceBlockedError on 403 without retrying", async () => {
    let attempts = 0;
    await expect(
      fetchGraphQL({ query: "q", fetchImpl: mk(403, "no"), onAttempt: () => attempts++ }),
    ).rejects.toBeInstanceOf(SourceBlockedError);
    expect(attempts).toBe(1);
  });
  it("classifies 429", async () => {
    const err = await fetchGraphQL({ query: "q", fetchImpl: mk(429, "") }).catch((x) => x);
    expect((err as SourceBlockedError).kind).toBe("http_429");
  });
  it("classifies a 200 HTML challenge page", async () => {
    const err = await fetchGraphQL({
      query: "q",
      fetchImpl: mk(200, "<html><body>Please complete the challenge</body></html>", "text/html"),
    }).catch((x) => x);
    expect(err).toBeInstanceOf(SourceBlockedError);
    expect((err as SourceBlockedError).kind).toBe("challenge");
  });
  it("counts every attempt including retries on plain errors", async () => {
    let attempts = 0;
    await expect(
      fetchGraphQL({ query: "q", fetchImpl: mk(500, "{}"), retries: 3, onAttempt: () => attempts++ }),
    ).rejects.toThrow("GraphQL HTTP 500");
    expect(attempts).toBe(3);
  });
  it("looksLikeChallenge is false for JSON", () => {
    expect(looksLikeChallenge("application/json", '{"data":{}}')).toBe(false);
  });
});

describe("quality.sample_interval_s", () => {
  it("is present on every envelope (null when unknown)", () => {
    const a = buildEnvelope({ event: "test", event_id: "x", seq: 1 });
    expect(a.quality.sample_interval_s).toBeNull();
    const b = buildEnvelope({ event: "odds_update", event_id: "y", seq: 2, sample_interval_s: 5 });
    expect(b.quality.sample_interval_s).toBe(5);
  });

  it("is stored with odds snapshots without affecting hash dedupe", async () => {
    const snap = buildRaceOddsSnapshot({
      race: { no: 7, postTime: "2026-10-07T21:00:00+08:00", runners: [{ no: "1", name_en: "A" }] },
      winPool: {
        oddsType: "WIN",
        sellStatus: "START_SELL",
        lastUpdateTime: "2026-10-07T20:00:00+08:00",
        oddsNodes: [{ combString: "01", oddsValue: "2.5" }],
      },
    });
    const a = await insertOddsSnapshotIfChanged(env.DB, "2026-10-07", "ST", snap, "graphql", 3);
    const b = await insertOddsSnapshotIfChanged(env.DB, "2026-10-07", "ST", snap, "graphql", 10);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    const row = await env.DB.prepare(
      `SELECT sample_interval_s FROM odds_snapshots WHERE meeting_date='2026-10-07' AND venue='ST' AND race_no=7`,
    ).first<{ sample_interval_s: number }>();
    expect(row?.sample_interval_s).toBe(3);
  });
});

describe("graphql usage + /health", () => {
  it("accumulates per HKT day and exposes today's count and block state in /health", async () => {
    const day = hkDay(Date.now());
    await env.DB.prepare(`DELETE FROM graphql_usage`).run();
    expect(await addGraphqlUsage(env.DB, day, 40)).toBe(40);
    expect(await addGraphqlUsage(env.DB, day, 2)).toBe(42);
    expect(await getGraphqlUsage(env.DB, "1999-01-01")).toBe(0);
    await setMeta(
      env.DB,
      "source_block_state",
      JSON.stringify({ ...HEALTHY_BLOCK_STATE, blocked: true, level: 2, reason: "http_429" }),
    );

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/health"), env, ctx);
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      poll_interval_ms: number;
      graphql_requests: { day: string; today: number; daily_budget: number; remaining: number };
      source_block: BlockState;
    };
    expect(body.poll_interval_ms).toBe(3000);
    expect(body.graphql_requests).toEqual({
      day,
      today: 42,
      daily_budget: 30_000,
      remaining: 29_958,
    });
    expect(body.source_block.blocked).toBe(true);
    expect(body.source_block.reason).toBe("http_429");
  });
});
