import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { recordDeliveryFailure, recordDeliverySuccess } from "../src/push/circuit";
import { createSubscriber } from "../src/push/subscribers";
import { setMeta } from "../src/store/db";

describe("/health hardening fields", () => {
  beforeEach(async () => {
    for (const t of ["push_subscribers", "push_log", "worker_meta", "pending_pushes"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("exposes circuit state, queue backlog, gave_up/pending counts, stage errors, poller age", async () => {
    const sub = await createSubscriber(env, { url: "https://health.example/hook" });
    await recordDeliverySuccess(env, sub.id, 202);
    await recordDeliveryFailure(env, sub.id, { http_status: 500, error_message: "HTTP 500" });
    await setMeta(env.DB, "push_queue_backlog", "3");
    await setMeta(env.DB, "stage_error_odds", "odds blew up");
    await setMeta(env.DB, "last_fetch_at", new Date(Date.now() - 30_000).toISOString());
    await env.DB.prepare(
      `INSERT INTO push_log (event_type, target_url, http_status, retry_count, success, payload_hash, error_message, sent_at)
       VALUES ('lock', 'https://health.example/hook', 202, 0, 1, 'abc', NULL, ?)`,
    )
      .bind("2026-10-12T12:00:00+08:00")
      .run();
    // Stale meta should be overridden by newest push_log of any type
    await setMeta(env.DB, "last_push_at", "2000-01-01T00:00:00.000Z");
    await setMeta(env.DB, "last_push_status", "odds_only");

    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
       VALUES
         ('odds_update', '{}', 0, '2000-01-01T00:00:00Z', '2026-09-01T00:00:00.000Z', 'gave_up', NULL, NULL),
         ('odds_update', '{}', 0, '2000-01-01T00:00:00Z', ?, NULL, ?, 'due-1'),
         ('odds_update', '{}', 5, NULL, ?, NULL, ?, 'def-1')`,
    )
      .bind(new Date().toISOString(), sub.id, new Date().toISOString(), sub.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO worker_meta (key, value, updated_at) VALUES (?, ?, ?)`,
    )
      .bind(`push_rate_delay_count_${sub.id}`, "7", new Date().toISOString())
      .run();

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/health"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      last_push_at: string;
      last_push_status: string;
      push_queue: {
        bound: boolean;
        backlog: number;
        pending_due: number;
        pending_deferred: number;
        gave_up: number;
        pending_pushes: number;
        rate_limit_delays: number;
      };
      subscribers: Array<{
        subscriber_id: number;
        circuit_state: string;
        last_failure_at: string | null;
        backlog_size?: number;
        rate_limit_delays?: number;
      }>;
      stage_errors: Record<string, string | null>;
      poller: { last_fetch_at: string | null; age_ms: number | null };
    };

    expect(body.last_push_at).toBe("2026-10-12T12:00:00+08:00");
    expect(body.last_push_status).toBe("202");
    // Template wrangler.toml binds PUSH_QUEUE; bound may be true in vitest.
    expect(typeof body.push_queue.bound).toBe("boolean");
    expect(body.push_queue.backlog).toBe(3);
    expect(body.push_queue.gave_up).toBe(1);
    expect(body.push_queue.pending_due).toBe(1);
    expect(body.push_queue.pending_deferred).toBe(1);
    expect(body.push_queue.pending_pushes).toBe(2);
    expect(body.push_queue.rate_limit_delays).toBe(7);
    const subHealth = body.subscribers.find((s) => s.subscriber_id === sub.id);
    expect(subHealth).toBeTruthy();
    expect(subHealth!.backlog_size).toBe(2);
    expect(subHealth!.rate_limit_delays).toBe(7);
    expect(body.stage_errors.odds).toContain("odds blew up");
    expect(body.poller.last_fetch_at).toBeTruthy();
    expect(body.poller.age_ms).toBeGreaterThan(0);
  });
});
