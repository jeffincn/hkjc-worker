import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { asD1Value, d1Bind, isStorageOrInfraError, rowsWrittenFromMeta } from "../src/util/d1";
import {
  allowD1Write,
  DEFAULT_D1_DAILY_WRITE_BUDGET,
  D1_DEGRADE_RATIO,
  d1DailyWriteBudget,
  flushD1WriteCounter,
  getD1WriteStats,
  mayWriteWhenDegraded,
  resetD1WriteCounter,
  trackD1RowsWritten,
  utcDay,
} from "../src/store/d1-budget";
import { enqueueRetry } from "../src/push/pending";
import { storeRawDocument } from "../src/store/horses";
import type { PushEnvelope } from "../src/push/envelope";

const e = (vars: Record<string, string>) => ({ ...env, ...vars }) as unknown as Env;

describe("d1 util", () => {
  it("asD1Value / d1Bind coerce undefined to null (no D1_TYPE_ERROR)", async () => {
    expect(asD1Value(undefined)).toBeNull();
    expect(asD1Value(null)).toBeNull();
    expect(asD1Value(0)).toBe(0);
    // Binding undefined used to throw D1_TYPE_ERROR; nullable columns accept null.
    await expect(
      d1Bind(
        env.DB.prepare(
          `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ),
        "odds_update",
        "{}",
        0,
        null,
        new Date().toISOString(),
        undefined, // last_error
        undefined, // subscriber_id
        undefined, // event_id
      ).run(),
    ).resolves.toBeTruthy();
  });

  it("isStorageOrInfraError detects D1 quota / type errors", () => {
    expect(isStorageOrInfraError(new Error("D1_TYPE_ERROR: Type 'undefined' not supported"))).toBe(
      true,
    );
    expect(
      isStorageOrInfraError(new Error("D1 free tier daily row write limit exceeded")),
    ).toBe(true);
    expect(isStorageOrInfraError(new Error("too many requests to D1Database"))).toBe(true);
    expect(isStorageOrInfraError(new Error("HTTP 429 from hkjc"))).toBe(false);
    expect(isStorageOrInfraError(new Error("ECONNRESET"))).toBe(false);
  });

  it("rowsWrittenFromMeta reads rows_written or changes", () => {
    expect(rowsWrittenFromMeta({ rows_written: 3 } as D1Meta)).toBe(3);
    expect(rowsWrittenFromMeta({ changes: 2 } as D1Meta)).toBe(2);
    expect(rowsWrittenFromMeta(null)).toBe(0);
  });
});

describe("enqueueRetry undefined binds", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM pending_pushes`).run();
  });

  it("accepts sparse envelopes without throwing D1_TYPE_ERROR", async () => {
    const sparse = {
      // missing event / event_id / sent_at — historically bound as undefined
    } as unknown as PushEnvelope;
    await expect(enqueueRetry(env, sparse, 0, undefined, null)).resolves.toBeUndefined();
    const row = await env.DB.prepare(
      `SELECT event_type, event_id, last_error FROM pending_pushes`,
    ).first<{ event_type: string; event_id: string | null; last_error: string | null }>();
    expect(row?.event_type).toBe("unknown");
    expect(row?.event_id).toBeNull();
    expect(row?.last_error).toBeNull();
  });
});

describe("D1 write budget", () => {
  beforeEach(async () => {
    resetD1WriteCounter();
    await env.DB.prepare(`DELETE FROM worker_meta`).run();
    await env.DB.prepare(`DELETE FROM raw_documents`).run();
    await env.DB.prepare(`DELETE FROM push_log`).run();
  });

  it("defaults budget to 40M and degrade at 80%", () => {
    expect(d1DailyWriteBudget(e({}))).toBe(DEFAULT_D1_DAILY_WRITE_BUDGET);
    expect(d1DailyWriteBudget(e({ D1_DAILY_WRITE_BUDGET: "1000" }))).toBe(1000);
    expect(mayWriteWhenDegraded("odds")).toBe(true);
    expect(mayWriteWhenDegraded("results")).toBe(true);
    expect(mayWriteWhenDegraded("dividends")).toBe(true);
    expect(mayWriteWhenDegraded("push_log")).toBe(false);
    expect(mayWriteWhenDegraded("raw_dup")).toBe(false);
  });

  it("tracks rows and exposes stats with remaining", async () => {
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    const testEnv = e({ D1_DAILY_WRITE_BUDGET: "1000" });
    await trackD1RowsWritten(testEnv, 100, now);
    await flushD1WriteCounter(testEnv, now);
    const stats = await getD1WriteStats(testEnv, now);
    expect(stats.day).toBe(utcDay(now));
    expect(stats.today).toBe(100);
    expect(stats.budget).toBe(1000);
    expect(stats.remaining).toBe(900);
    expect(stats.degrade).toBe(false);
    expect(stats.degrade_threshold).toBe(Math.floor(1000 * D1_DEGRADE_RATIO));
  });

  it("degrades non-essential writes above 80% of budget", async () => {
    // allowD1Write → isD1WriteDegraded uses Date.now() for the UTC day key,
    // so track/flush must use the same calendar day (not a fixed fixture date).
    const now = Date.now();
    const testEnv = e({ D1_DAILY_WRITE_BUDGET: "1000" });
    // 80% of 1000 = 800
    await trackD1RowsWritten(testEnv, 800, now);
    await flushD1WriteCounter(testEnv, now);
    expect(await allowD1Write(testEnv, "push_log")).toBe(false);
    expect(await allowD1Write(testEnv, "raw_dup")).toBe(false);
    expect(await allowD1Write(testEnv, "odds")).toBe(true);
    expect(await allowD1Write(testEnv, "results")).toBe(true);
    expect(await allowD1Write(testEnv, "dividends")).toBe(true);
    expect(await allowD1Write(testEnv, "essential")).toBe(true);
  });

  it("storeRawDocument skips D1 write when content hash unchanged", async () => {
    const a = await storeRawDocument(env.DB, "test_doc", "k1", { v: 1 }, null);
    expect(a.changed).toBe(true);
    const count1 = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM raw_documents WHERE doc_type=? AND doc_key=?`,
    )
      .bind("test_doc", "k1")
      .first<{ n: number }>();
    expect(Number(count1?.n)).toBe(1);

    const b = await storeRawDocument(env.DB, "test_doc", "k1", { v: 1 }, null);
    expect(b.changed).toBe(false);
    const count2 = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM raw_documents WHERE doc_type=? AND doc_key=?`,
    )
      .bind("test_doc", "k1")
      .first<{ n: number }>();
    // No new row and no UPDATE — still exactly one row.
    expect(Number(count2?.n)).toBe(1);
    const fetched = await env.DB.prepare(
      `SELECT fetched_at FROM raw_documents WHERE doc_type=? AND doc_key=?`,
    )
      .bind("test_doc", "k1")
      .first<{ fetched_at: string }>();
    // fetched_at unchanged (no bump-on-dup write)
    const firstFetched = await env.DB.prepare(
      `SELECT fetched_at FROM raw_documents WHERE doc_type=? AND doc_key=? ORDER BY id`,
    )
      .bind("test_doc", "k1")
      .first<{ fetched_at: string }>();
    expect(fetched?.fetched_at).toBe(firstFetched?.fetched_at);
  });

  it("/health exposes d1_writes {today,budget,remaining}", async () => {
    const now = Date.now();
    const testEnv = e({ D1_DAILY_WRITE_BUDGET: "5000" });
    await trackD1RowsWritten(testEnv, 42, now);
    await flushD1WriteCounter(testEnv, now);

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/health"), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      d1_writes: {
        day: string;
        today: number;
        budget: number;
        remaining: number;
        degrade: boolean;
      };
    };
    expect(body.d1_writes.budget).toBe(5000);
    expect(body.d1_writes.today).toBeGreaterThanOrEqual(42);
    expect(body.d1_writes.remaining).toBe(body.d1_writes.budget - body.d1_writes.today);
    expect(typeof body.d1_writes.degrade).toBe("boolean");
    expect(body.d1_writes.day).toBe(utcDay(now));
  });
});
