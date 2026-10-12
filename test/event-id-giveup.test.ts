import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { preparePushEvent } from "../src/push/emit";
import { buildEnvelope } from "../src/push/envelope";
import {
  PUSH_1_1_DEPLOY_CUTOFF,
  ensureEventId,
  isLegacyGiveUpCandidate,
  requireEventId,
} from "../src/push/event-id";
import { enqueueRetry, GAVE_UP } from "../src/push/pending";
import {
  createRetryRunState,
  flushDueRetries,
  giveUpStaleLegacyPending,
} from "../src/push/pusher";
import { createSubscriber } from "../src/push/subscribers";

async function reset() {
  for (const t of ["push_subscribers", "pending_pushes", "push_log", "push_events", "push_seq", "worker_meta"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

describe("event_id guarantee + gave_up scope (#12)", () => {
  beforeEach(reset);

  it("ensureEventId / requireEventId generate UUID for 1.1 envelopes missing id", () => {
    const bare = buildEnvelope({
      event: "test",
      event_id: "",
      races: [],
    });
    // Force empty (buildEnvelope normally assigns)
    (bare as { event_id: string }).event_id = "";
    const ensured = ensureEventId(bare);
    expect(ensured.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const id = requireEventId(bare);
    expect(id.length).toBeGreaterThan(0);
    expect(bare.event_id).toBe(id);
  });

  it("preparePushEvent + enqueueRetry never store empty event_id for 1.1", async () => {
    const envelope = await preparePushEvent(env, {
      event: "odds_update",
      meeting_date: "2026-10-12",
      venue: "ST",
      races: [],
      source_last_updated_at: null,
    });
    expect(envelope.event_id.length).toBeGreaterThan(0);

    // Simulate a buggy caller that cleared event_id on a 1.1 envelope
    const broken = { ...envelope, event_id: "" };
    await enqueueRetry(env, broken, 0, "HTTP 500", null);
    const row = await env.DB.prepare(
      `SELECT event_id, payload_json FROM pending_pushes`,
    ).first<{ event_id: string; payload_json: string }>();
    expect(row?.event_id).toBeTruthy();
    expect(row!.event_id.length).toBeGreaterThan(0);
    expect(JSON.parse(row!.payload_json).event_id).toBe(row!.event_id);
  });

  it("isLegacyGiveUpCandidate rejects post-1.1 and post-cutoff rows", () => {
    expect(
      isLegacyGiveUpCandidate({
        event_id: null,
        created_at: "2026-09-01T00:00:00.000Z",
        payload_json: JSON.stringify({ event: "odds_update" }),
      }),
    ).toBe(true);

    expect(
      isLegacyGiveUpCandidate({
        event_id: "evt-1",
        created_at: "2026-09-01T00:00:00.000Z",
        payload_json: "{}",
      }),
    ).toBe(false);

    expect(
      isLegacyGiveUpCandidate({
        event_id: null,
        created_at: "2026-10-11T00:00:00.000Z", // after cutoff
        payload_json: "{}",
      }),
    ).toBe(false);
    expect("2026-10-11T00:00:00.000Z" >= PUSH_1_1_DEPLOY_CUTOFF).toBe(true);

    expect(
      isLegacyGiveUpCandidate({
        event_id: "",
        created_at: "2026-09-01T00:00:00.000Z",
        payload_json: JSON.stringify({ schema: "hkjc-push/1.1", event: "test" }),
      }),
    ).toBe(false);
  });

  it("giveUpStaleLegacyPending never abandons 1.1 schema or post-cutoff empty-id rows", async () => {
    const stale = new Date(Date.now() - 48 * 3600_000).toISOString();
    // Pre-cutoff legacy — eligible
    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id)
       VALUES ('odds_update', ?, 0, '2000-01-01T00:00:00Z', '2026-09-01T00:00:00.000Z', 'HTTP 429', NULL)`,
    )
      .bind(JSON.stringify({ event: "odds_update", sent_at: "2026-09-01" }))
      .run();

    // Post-cutoff but empty event_id — must NOT give up
    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id)
       VALUES ('odds_update', ?, 0, '2000-01-01T00:00:00Z', ?, 'HTTP 429', NULL)`,
    )
      .bind(JSON.stringify({ event: "odds_update" }), stale)
      .run();

    // 1.1 schema with empty event_id but old created_at — must NOT give up
    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id)
       VALUES ('odds_update', ?, 0, '2000-01-01T00:00:00Z', '2026-09-01T00:00:00.000Z', 'HTTP 429', NULL)`,
    )
      .bind(JSON.stringify({ schema: "hkjc-push/1.1", event: "odds_update", event_id: "" }))
      .run();

    const n = await giveUpStaleLegacyPending(env);
    expect(n).toBe(1);

    const rows = await env.DB.prepare(
      `SELECT last_error, created_at FROM pending_pushes ORDER BY id`,
    ).all<{ last_error: string | null; created_at: string }>();
    expect(rows.results![0]!.last_error).toBe(GAVE_UP);
    expect(rows.results![1]!.last_error).toBe("HTTP 429");
    expect(rows.results![2]!.last_error).toBe("HTTP 429");
  });

  it("per-run retry cap defers excess rows (does not drop or give_up)", async () => {
    const sub = await createSubscriber(env, { url: "https://cap.example/hook" });
    const ok: typeof fetch = async () => new Response("{}", { status: 202 });

    for (let i = 0; i < 12; i++) {
      await env.DB.prepare(
        `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
         VALUES ('odds_update', ?, 0, '2000-01-01T00:00:00Z', ?, NULL, ?, ?)`,
      )
        .bind(
          JSON.stringify({
            schema: "hkjc-push/1.1",
            event: "odds_update",
            event_id: `cap-${i}`,
          }),
          new Date().toISOString(),
          sub.id,
          `cap-${i}`,
        )
        .run();
    }

    const state = createRetryRunState(env);
    expect(state.max).toBe(5);
    const sent = await flushDueRetries(env, { fetchImpl: ok, retryState: state });
    expect(sent).toBe(5);
    expect(state.sent).toBe(5);

    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN last_error = ? THEN 1 ELSE 0 END) AS gave
       FROM pending_pushes`,
    )
      .bind(GAVE_UP)
      .first<{ n: number; gave: number }>();
    // 7 untouched — deferred to a later invocation, not dropped
    expect(remaining?.n).toBe(7);
    expect(remaining?.gave ?? 0).toBe(0);

    const ids = await env.DB.prepare(`SELECT event_id FROM pending_pushes`).all<{
      event_id: string;
    }>();
    expect(new Set(ids.results!.map((r) => r.event_id))).toEqual(
      new Set(["cap-5", "cap-6", "cap-7", "cap-8", "cap-9", "cap-10", "cap-11"]),
    );
  });
});
