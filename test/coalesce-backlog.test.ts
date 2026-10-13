import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  backlogMaxChanges,
  buildCoalescedDeliveries,
  planMeetingCoalesce,
  shouldCoalesceBacklog,
  type PendingPushRow,
} from "../src/push/coalesce";
import { preparePushEvent } from "../src/push/emit";
import type { OddsDeltaChange, PushEnvelope } from "../src/push/envelope";
import { flushDueRetries } from "../src/push/pusher";
import { createSubscriber } from "../src/push/subscribers";

async function reset() {
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
  env.PUSH_BACKLOG_COALESCE_MIN = "2";
  env.PUSH_BACKLOG_MAX_CHANGES = "200";
  env.PUSH_RATE_PER_SUB_PER_SEC = "100";
}

function change(
  race_no: number,
  runner_no: number,
  prev: number | null,
  next: number | null,
): OddsDeltaChange {
  return {
    race_no,
    runner_no,
    horse_name_ch: null,
    horse_name_en: `H${runner_no}`,
    bet_type: "WIN",
    odds_basis: "HKD total return per $1 unit incl. stake",
    prev_odds: prev,
    new_odds: next,
    source_last_updated_at: null,
    race_post_time: null,
    pool_status: "Defined",
  };
}

describe("backlog replay coalescing", () => {
  beforeEach(reset);

  it("shouldCoalesceBacklog respects threshold", () => {
    expect(shouldCoalesceBacklog(1, 2)).toBe(false);
    expect(shouldCoalesceBacklog(2, 2)).toBe(true);
  });

  it("merges odds_delta changes in order with per-change seq/captured_at", () => {
    const e1 = {
      schema: "hkjc-push/1.1" as const,
      event: "odds_delta" as const,
      event_id: "e1",
      seq: 10,
      captured_at: "2026-10-12T12:00:01+08:00",
      sent_at: "2026-10-12T12:00:01+08:00",
      meeting_date: "2026-10-12",
      venue: "ST",
      source: { name: "HKJC GraphQL" as const, url: "https://x", last_updated_at: null },
      quality: {
        missing_source_time: true,
        post_start: false,
        late_ms: 0,
        sample_interval_s: null,
      },
      races: [],
      changes: [change(1, 1, 3.0, 3.5)],
      pools: [],
    };
    const e2 = {
      ...e1,
      event_id: "e2",
      seq: 11,
      captured_at: "2026-10-12T12:00:04+08:00",
      sent_at: "2026-10-12T12:00:04+08:00",
      changes: [change(1, 1, 3.5, 4.0), change(1, 2, null, 10)],
    };

    const rows: Array<{ row: PendingPushRow; envelope: PushEnvelope }> = [
      {
        row: {
          id: 1,
          event_type: "odds_delta",
          payload_json: "{}",
          retry_count: 0,
          subscriber_id: 1,
          event_id: "e1",
          last_error: null,
        },
        envelope: e1,
      },
      {
        row: {
          id: 2,
          event_type: "odds_delta",
          payload_json: "{}",
          retry_count: 1,
          subscriber_id: 1,
          event_id: "e2",
          last_error: null,
        },
        envelope: e2,
      },
    ];

    const plan = planMeetingCoalesce(rows, 200);
    expect(plan.oddsChunks).toHaveLength(1);
    const chunk = plan.oddsChunks[0]!;
    expect(chunk.changes).toHaveLength(3);
    expect(chunk.changes[0]).toMatchObject({
      prev_odds: 3.0,
      new_odds: 3.5,
      seq: 10,
      captured_at: "2026-10-12T12:00:01+08:00",
    });
    expect(chunk.changes[1]).toMatchObject({
      prev_odds: 3.5,
      new_odds: 4.0,
      seq: 11,
      captured_at: "2026-10-12T12:00:04+08:00",
    });
    expect(chunk.seq_from).toBe(10);
    expect(chunk.seq_to).toBe(11);
  });

  it("collapses non-odds same type to latest and size-bounds odds chunks", () => {
    const base = {
      schema: "hkjc-push/1.1" as const,
      sent_at: "2026-10-12T12:00:01+08:00",
      meeting_date: "2026-10-12",
      venue: "HV",
      source: { name: "HKJC GraphQL" as const, url: "https://x", last_updated_at: null },
      quality: {
        missing_source_time: true,
        post_start: false,
        late_ms: 0,
        sample_interval_s: null,
      },
      races: [],
    };
    const lock1: PushEnvelope = {
      ...base,
      event: "lock",
      event_id: "l1",
      seq: 1,
      captured_at: "2026-10-12T12:00:01+08:00",
    };
    const lock2: PushEnvelope = {
      ...base,
      event: "lock",
      event_id: "l2",
      seq: 5,
      captured_at: "2026-10-12T12:00:05+08:00",
    };
    const d1: PushEnvelope = {
      ...base,
      event: "odds_delta",
      event_id: "d1",
      seq: 2,
      captured_at: "2026-10-12T12:00:02+08:00",
      changes: [change(1, 1, 1, 2)],
      pools: [],
    };
    const d2: PushEnvelope = {
      ...base,
      event: "odds_delta",
      event_id: "d2",
      seq: 3,
      captured_at: "2026-10-12T12:00:03+08:00",
      changes: [change(1, 1, 2, 3)],
      pools: [],
    };

    const rows = [
      { row: { id: 1, event_type: "lock", payload_json: "{}", retry_count: 0, subscriber_id: 1, event_id: "l1", last_error: null }, envelope: lock1 },
      { row: { id: 2, event_type: "odds_delta", payload_json: "{}", retry_count: 0, subscriber_id: 1, event_id: "d1", last_error: null }, envelope: d1 },
      { row: { id: 3, event_type: "odds_delta", payload_json: "{}", retry_count: 0, subscriber_id: 1, event_id: "d2", last_error: null }, envelope: d2 },
      { row: { id: 4, event_type: "lock", payload_json: "{}", retry_count: 0, subscriber_id: 1, event_id: "l2", last_error: null }, envelope: lock2 },
    ];

    const plan = planMeetingCoalesce(rows, 1);
    expect(plan.latestByType).toHaveLength(1);
    expect(plan.latestByType[0]!.envelope.event_id).toBe("l2");
    expect(plan.oddsChunks).toHaveLength(2);
    expect(plan.oddsChunks[0]!.changes).toHaveLength(1);
    expect(plan.oddsChunks[1]!.changes).toHaveLength(1);
  });

  it("flushDueRetries coalesces backlog into backlog_replay instead of one-by-one", async () => {
    const sub = await createSubscriber(env, { url: "https://coal.example/hook" });

    const e1 = await preparePushEvent(env, {
      event: "odds_delta",
      meeting_date: "2026-10-12",
      venue: "ST",
      races: [],
      changes: [change(1, 1, 2, 3)],
      pools: [],
      source_last_updated_at: null,
    });
    const e2 = await preparePushEvent(env, {
      event: "odds_delta",
      meeting_date: "2026-10-12",
      venue: "ST",
      races: [],
      changes: [change(1, 1, 3, 4)],
      pools: [],
      source_last_updated_at: null,
    });
    const e3 = await preparePushEvent(env, {
      event: "odds_delta",
      meeting_date: "2026-10-12",
      venue: "ST",
      races: [],
      changes: [change(2, 1, null, 8)],
      pools: [],
      source_last_updated_at: null,
    });

    for (const e of [e1, e2, e3]) {
      await env.DB.prepare(
        `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
         VALUES ('odds_delta', ?, 0, '2000-01-01T00:00:00Z', ?, NULL, ?, ?)`,
      )
        .bind(JSON.stringify(e), new Date().toISOString(), sub.id, e.event_id)
        .run();
    }

    const bodies: PushEnvelope[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as PushEnvelope);
      return new Response("{}", { status: 202 });
    };

    const sent = await flushDueRetries(env, { fetchImpl });
    expect(sent).toBe(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.event).toBe("backlog_replay");
    expect(bodies[0]!.changes).toHaveLength(3);
    expect(bodies[0]!.meta).toMatchObject({
      covered_seq_from: e1.seq,
      covered_seq_to: e3.seq,
      coalesced_count: 3,
    });
    expect(bodies[0]!.changes![0]).toMatchObject({
      seq: e1.seq,
      captured_at: e1.captured_at,
      prev_odds: 2,
      new_odds: 3,
    });
    expect(bodies[0]!.changes![2]).toMatchObject({
      seq: e3.seq,
      prev_odds: null,
      new_odds: 8,
    });

    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pending_pushes`,
    ).first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it("buildCoalescedDeliveries writes ledger backlog_replay with covered seq range", async () => {
    expect(backlogMaxChanges(env)).toBe(200);
    const e1 = await preparePushEvent(env, {
      event: "odds_delta",
      meeting_date: "2026-10-13",
      venue: "HV",
      races: [],
      changes: [change(1, 1, 1, 2)],
      pools: [{ race_no: 1, bet_type: "WIN", investment: 100 }],
      source_last_updated_at: null,
    });
    const e2 = await preparePushEvent(env, {
      event: "odds_delta",
      meeting_date: "2026-10-13",
      venue: "HV",
      races: [],
      changes: [change(1, 1, 2, 2.5)],
      pools: [{ race_no: 1, bet_type: "WIN", investment: 110 }],
      source_last_updated_at: null,
    });

    const rows: PendingPushRow[] = [
      {
        id: 101,
        event_type: "odds_delta",
        payload_json: JSON.stringify(e1),
        retry_count: 0,
        subscriber_id: 1,
        event_id: e1.event_id,
        last_error: null,
      },
      {
        id: 102,
        event_type: "odds_delta",
        payload_json: JSON.stringify(e2),
        retry_count: 0,
        subscriber_id: 1,
        event_id: e2.event_id,
        last_error: null,
      },
    ];

    const deliveries = await buildCoalescedDeliveries(env, rows);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.envelope.event).toBe("backlog_replay");
    expect(deliveries[0]!.envelope.event_id).toBeTruthy();
    expect(deliveries[0]!.envelope.event_id).not.toBe(e1.event_id);
    expect(deliveries[0]!.envelope.meta).toMatchObject({
      covered_seq_from: e1.seq,
      covered_seq_to: e2.seq,
      reason: "pending_backlog",
    });
  });
});
