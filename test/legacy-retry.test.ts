import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createRetryRunState,
  flushDueRetries,
  GAVE_UP,
  giveUpStaleLegacyPending,
  piggybackPending,
} from "../src/push/pusher";
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

function recentIso(hoursAgo = 1): string {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

function staleIso(hoursAgo = 25): string {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

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
       VALUES ('odds_update', ?, 0, '2000-01-01T00:00:00Z', ?, 'HTTP 429', ?)`,
    )
      .bind(JSON.stringify(LEGACY), recentIso(), sub.id)
      .run();

    await expect(flushDueRetries(env, { fetchImpl: failing })).resolves.toBe(1);

    const rows = await env.DB.prepare(`SELECT event_id, retry_count FROM pending_pushes`).all();
    expect(rows.results).toEqual([{ event_id: null, retry_count: 1 }]);

    const log = await env.DB.prepare(`SELECT sent_at FROM push_log ORDER BY id DESC LIMIT 1`).first<{
      sent_at: string;
    }>();
    // push_log.sent_at is the attempt time, not the stale envelope sent_at
    expect(log?.sent_at).not.toBe(LEGACY.sent_at);
  });

  it("piggybackPending handles legacy rows", async () => {
    const sub = await createSubscriber(env, { url: "https://example.test/hook" });
    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id)
       VALUES ('odds_update', ?, 5, NULL, ?, 'HTTP 429', ?)`,
    )
      .bind(JSON.stringify(LEGACY), recentIso(), sub.id)
      .run();
    await expect(piggybackPending(env, { fetchImpl: failing })).resolves.toBe(1);
    const row = await env.DB.prepare(`SELECT event_id FROM pending_pushes`).first();
    expect(row).toEqual({ event_id: null });
  });
});

describe("pending_pushes retry budget + legacy give-up", () => {
  beforeEach(reset);
  const ok: typeof fetch = async () => new Response("{}", { status: 202 });
  const rateLimited: typeof fetch = async () => new Response("rate limited", { status: 429 });

  it("caps retry sends per invocation (default 5)", async () => {
    const sub = await createSubscriber(env, { url: "https://example.test/hook" });
    for (let i = 0; i < 12; i++) {
      await env.DB.prepare(
        `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
         VALUES ('odds_update', ?, 0, '2000-01-01T00:00:00Z', ?, NULL, ?, 'evt-${i}')`,
      )
        .bind(JSON.stringify({ ...LEGACY, event_id: `evt-${i}` }), recentIso(), sub.id)
        .run();
    }

    const sent = await flushDueRetries(env, { fetchImpl: ok });
    expect(sent).toBe(5);

    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pending_pushes WHERE IFNULL(last_error, '') != ?`,
    )
      .bind(GAVE_UP)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(7);
  });

  it("skips further retries for a subscriber that got 429 in this run", async () => {
    const subA = await createSubscriber(env, { url: "https://example.test/a" });
    const subB = await createSubscriber(env, { url: "https://example.test/b" });

    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
       VALUES
         ('odds_update', ?, 0, '2000-01-01T00:00:00Z', ?, NULL, ?, 'evt-a1'),
         ('odds_update', ?, 0, '2000-01-01T00:00:01Z', ?, NULL, ?, 'evt-a2'),
         ('odds_update', ?, 0, '2000-01-01T00:00:02Z', ?, NULL, ?, 'evt-b1')`,
    )
      .bind(
        JSON.stringify(LEGACY),
        recentIso(),
        subA.id,
        JSON.stringify(LEGACY),
        recentIso(),
        subA.id,
        JSON.stringify(LEGACY),
        recentIso(),
        subB.id,
      )
      .run();

    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      if (String(input).includes("/a")) return rateLimited(input as Request);
      return ok(input as Request);
    };

    const sent = await flushDueRetries(env, { fetchImpl });
    // a1 (429) + b1 (ok); a2 skipped because A already 429'd this run
    expect(sent).toBe(2);
    expect(urls.filter((u) => u.includes("/a"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("/b"))).toHaveLength(1);

    const a2 = await env.DB.prepare(
      `SELECT event_id FROM pending_pushes WHERE event_id = 'evt-a2'`,
    ).first();
    expect(a2).toEqual({ event_id: "evt-a2" });
  });

  it("marks legacy rows older than 24h as gave_up without sending or deleting", async () => {
    const sub = await createSubscriber(env, { url: "https://example.test/hook" });
    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id)
       VALUES ('odds_update', ?, 0, '2000-01-01T00:00:00Z', ?, 'HTTP 429', ?)`,
    )
      .bind(JSON.stringify(LEGACY), staleIso(30), sub.id)
      .run();

    let fetches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      fetches++;
      return ok(input, init);
    };

    const sent = await flushDueRetries(env, { fetchImpl });
    expect(sent).toBe(0);
    expect(fetches).toBe(0);

    const row = await env.DB.prepare(
      `SELECT last_error, next_retry_at, event_id FROM pending_pushes`,
    ).first<{ last_error: string; next_retry_at: string | null; event_id: string | null }>();
    expect(row).toEqual({ last_error: GAVE_UP, next_retry_at: null, event_id: null });

    // Idempotent / no delete
    expect(await giveUpStaleLegacyPending(env)).toBe(0);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pending_pushes`).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("still retries 1.1 rows (with event_id) older than 24h", async () => {
    const sub = await createSubscriber(env, { url: "https://example.test/hook" });
    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
       VALUES ('odds_update', ?, 0, '2000-01-01T00:00:00Z', ?, 'HTTP 500', ?, 'evt-11')`,
    )
      .bind(JSON.stringify({ ...LEGACY, event_id: "evt-11" }), staleIso(48), sub.id)
      .run();

    const sent = await flushDueRetries(env, { fetchImpl: ok });
    expect(sent).toBe(1);
    const remaining = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pending_pushes`).first<{
      n: number;
    }>();
    expect(remaining?.n).toBe(0);
  });

  it("shares send budget between piggyback and flush in one run", async () => {
    const sub = await createSubscriber(env, { url: "https://example.test/hook" });
    const state = createRetryRunState(env);
    expect(state.max).toBe(5);

    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
         VALUES ('odds_update', ?, 5, NULL, ?, NULL, ?, ?)`,
      )
        .bind(JSON.stringify(LEGACY), recentIso(), sub.id, `pig-${i}`)
        .run();
    }
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare(
        `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
         VALUES ('odds_update', ?, 0, '2000-01-01T00:00:00Z', ?, NULL, ?, ?)`,
      )
        .bind(JSON.stringify(LEGACY), recentIso(), sub.id, `due-${i}`)
        .run();
    }

    const pig = await piggybackPending(env, { fetchImpl: ok, retryState: state });
    const flushed = await flushDueRetries(env, { fetchImpl: ok, retryState: state });
    expect(pig).toBe(3);
    expect(flushed).toBe(2);
    expect(state.sent).toBe(5);
  });
});
