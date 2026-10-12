import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { flushDueRetries, piggybackPending } from "../src/push/pusher";
import { createSubscriber } from "../src/push/subscribers";

// Regression: pre-1.1 pending_pushes rows have no event_id in payload_json.
// Re-enqueueing them after a failed retry bound `undefined` to D1 and threw
// D1_TYPE_ERROR, which aborted the whole ingest (POST /v1/admin/ingest + cron).
const LEGACY = {
  event: "odds_update",
  meeting_date: "2026-10-11",
  venue: "ST",
  sent_at: "2026-10-11T16:06:29+08:00",
  races: [],
};

async function reset() {
  for (const t of ["push_subscribers", "pending_pushes", "push_log", "push_events", "push_seq"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

describe("legacy pending_pushes without event_id", () => {
  beforeEach(reset);
  const failing: typeof fetch = async () => new Response("rate limited", { status: 429 });

  it("flushDueRetries re-enqueues with event_id NULL instead of throwing", async () => {
    const sub = await createSubscriber(env, { url: "https://example.test/hook" });
    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id)
       VALUES ('odds_update', ?, 0, '2000-01-01T00:00:00Z', '2026-10-11T08:06:29Z', 'HTTP 429', ?)`,
    ).bind(JSON.stringify(LEGACY), sub.id).run();

    await expect(flushDueRetries(env, { fetchImpl: failing })).resolves.toBe(1);

    const rows = await env.DB.prepare(`SELECT event_id, retry_count FROM pending_pushes`).all();
    expect(rows.results).toEqual([{ event_id: null, retry_count: 1 }]);

    const log = await env.DB.prepare(`SELECT sent_at FROM push_log ORDER BY id DESC LIMIT 1`).first<{ sent_at: string }>();
    // push_log.sent_at is the attempt time, not the stale envelope sent_at
    expect(log?.sent_at).not.toBe(LEGACY.sent_at);
  });

  it("piggybackPending handles legacy rows", async () => {
    const sub = await createSubscriber(env, { url: "https://example.test/hook" });
    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id)
       VALUES ('odds_update', ?, 5, NULL, '2026-10-11T08:06:29Z', 'HTTP 429', ?)`,
    ).bind(JSON.stringify(LEGACY), sub.id).run();
    await expect(piggybackPending(env, { fetchImpl: failing })).resolves.toBe(1);
    const row = await env.DB.prepare(`SELECT event_id FROM pending_pushes`).first();
    expect(row).toEqual({ event_id: null });
  });
});
