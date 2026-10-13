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
  env.PUSH_RETRY_MAX_PER_RUN = "20";
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

  it("collapses meeting-snapshot types to latest and size-bounds odds chunks", () => {
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
    const snap1: PushEnvelope = {
      ...base,
      event: "odds_update",
      event_id: "s1",
      seq: 1,
      captured_at: "2026-10-12T12:00:01+08:00",
    };
    const snap2: PushEnvelope = {
      ...base,
      event: "odds_update",
      event_id: "s2",
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
      { row: { id: 1, event_type: "odds_update", payload_json: "{}", retry_count: 0, subscriber_id: 1, event_id: "s1", last_error: null }, envelope: snap1 },
      { row: { id: 2, event_type: "odds_delta", payload_json: "{}", retry_count: 0, subscriber_id: 1, event_id: "d1", last_error: null }, envelope: d1 },
      { row: { id: 3, event_type: "odds_delta", payload_json: "{}", retry_count: 0, subscriber_id: 1, event_id: "d2", last_error: null }, envelope: d2 },
      { row: { id: 4, event_type: "odds_update", payload_json: "{}", retry_count: 0, subscriber_id: 1, event_id: "s2", last_error: null }, envelope: snap2 },
    ];

    const plan = planMeetingCoalesce(rows, 1);
    expect(plan.nonOddsDeliveries).toHaveLength(1);
    expect(plan.nonOddsDeliveries[0]!.envelope.event_id).toBe("s2");
    expect(plan.oddsChunks).toHaveLength(2);
    expect(plan.oddsChunks[0]!.changes).toHaveLength(1);
    expect(plan.oddsChunks[1]!.changes).toHaveLength(1);
  });

  it("keeps lock/result/dividends per race_no so no race is dropped", () => {
    const base = {
      schema: "hkjc-push/1.1" as const,
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
    };
    const race = (race_no: number) => ({
      race_no,
      post_time: null,
      snapshot_time: "2026-10-12T12:00:00+08:00",
      pool_status: "Closed",
      runners: [],
    });

    const lockR1: PushEnvelope = {
      ...base,
      event: "lock",
      event_id: "lock-r1",
      seq: 1,
      captured_at: "2026-10-12T12:00:01+08:00",
      races: [race(1)],
    };
    const lockR2: PushEnvelope = {
      ...base,
      event: "lock",
      event_id: "lock-r2",
      seq: 2,
      captured_at: "2026-10-12T12:00:02+08:00",
      races: [race(2)],
    };
    // Later lock for race 1 must supersede the earlier one, not race 2.
    const lockR1b: PushEnvelope = {
      ...base,
      event: "lock",
      event_id: "lock-r1b",
      seq: 3,
      captured_at: "2026-10-12T12:00:03+08:00",
      races: [race(1)],
    };
    const resultR1: PushEnvelope = {
      ...base,
      event: "result",
      event_id: "res-r1",
      seq: 4,
      captured_at: "2026-10-12T12:00:04+08:00",
      races: [race(1)],
    };
    const resultR3: PushEnvelope = {
      ...base,
      event: "result",
      event_id: "res-r3",
      seq: 5,
      captured_at: "2026-10-12T12:00:05+08:00",
      races: [race(3)],
    };
    const divR2: PushEnvelope = {
      ...base,
      event: "dividends",
      event_id: "div-r2",
      seq: 6,
      captured_at: "2026-10-12T12:00:06+08:00",
      races: [race(2)],
      meta: { race_nos: [2] },
    };
    const divR4: PushEnvelope = {
      ...base,
      event: "dividends",
      event_id: "div-r4",
      seq: 7,
      captured_at: "2026-10-12T12:00:07+08:00",
      races: [race(4)],
      meta: { race_nos: [4] },
    };

    const mk = (
      id: number,
      envelope: PushEnvelope,
    ): { row: PendingPushRow; envelope: PushEnvelope } => ({
      row: {
        id,
        event_type: envelope.event,
        payload_json: "{}",
        retry_count: 0,
        subscriber_id: 1,
        event_id: envelope.event_id,
        last_error: null,
      },
      envelope,
    });

    const plan = planMeetingCoalesce(
      [
        mk(1, lockR1),
        mk(2, lockR2),
        mk(3, lockR1b),
        mk(4, resultR1),
        mk(5, resultR3),
        mk(6, divR2),
        mk(7, divR4),
      ],
      200,
    );

    const locks = plan.nonOddsDeliveries.filter((d) => d.envelope.event === "lock");
    const results = plan.nonOddsDeliveries.filter((d) => d.envelope.event === "result");
    const divs = plan.nonOddsDeliveries.filter((d) => d.envelope.event === "dividends");

    // R1 + R2 locks kept; superseded lock-r1 dropped
    expect(locks.map((l) => l.envelope.event_id).sort()).toEqual(["lock-r1b", "lock-r2"]);
    expect(locks.flatMap((l) => l.envelope.races.map((r) => r.race_no)).sort()).toEqual([1, 2]);

    // Both result races preserved
    expect(results.map((r) => r.envelope.event_id).sort()).toEqual(["res-r1", "res-r3"]);
    expect(results.flatMap((r) => r.envelope.races.map((x) => x.race_no)).sort()).toEqual([1, 3]);

    // Both dividends races preserved
    expect(divs.map((d) => d.envelope.event_id).sort()).toEqual(["div-r2", "div-r4"]);
    expect(divs.flatMap((d) => d.envelope.races.map((r) => r.race_no)).sort()).toEqual([2, 4]);
  });

  it("resends per-race events one-by-one when race_no cannot be determined", () => {
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
      races: [] as PushEnvelope["races"],
    };
    const a: PushEnvelope = {
      ...base,
      event: "lock",
      event_id: "lock-unknown-a",
      seq: 1,
      captured_at: "2026-10-12T12:00:01+08:00",
    };
    const b: PushEnvelope = {
      ...base,
      event: "lock",
      event_id: "lock-unknown-b",
      seq: 2,
      captured_at: "2026-10-12T12:00:02+08:00",
    };
    const plan = planMeetingCoalesce(
      [
        {
          row: {
            id: 1,
            event_type: "lock",
            payload_json: "{}",
            retry_count: 0,
            subscriber_id: 1,
            event_id: "lock-unknown-a",
            last_error: null,
          },
          envelope: a,
        },
        {
          row: {
            id: 2,
            event_type: "lock",
            payload_json: "{}",
            retry_count: 0,
            subscriber_id: 1,
            event_id: "lock-unknown-b",
            last_error: null,
          },
          envelope: b,
        },
      ],
      200,
    );
    expect(plan.nonOddsDeliveries).toHaveLength(2);
    expect(plan.nonOddsDeliveries.map((d) => d.envelope.event_id)).toEqual([
      "lock-unknown-a",
      "lock-unknown-b",
    ]);
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

  it("flushDueRetries preserves every race's lock/result/dividends across backlog", async () => {
    env.PUSH_RETRY_MAX_PER_RUN = "20";
    const sub = await createSubscriber(env, { url: "https://races.example/hook" });
    const race = (race_no: number) => ({
      race_no,
      post_time: null as string | null,
      snapshot_time: "2026-10-12T18:00:00+08:00",
      pool_status: "Closed",
      runners: [],
    });

    const lock1 = await preparePushEvent(env, {
      event: "lock",
      meeting_date: "2026-10-12",
      venue: "ST",
      races: [race(1)],
      source_last_updated_at: null,
    });
    const lock2 = await preparePushEvent(env, {
      event: "lock",
      meeting_date: "2026-10-12",
      venue: "ST",
      races: [race(2)],
      source_last_updated_at: null,
    });
    const result1 = await preparePushEvent(env, {
      event: "result",
      meeting_date: "2026-10-12",
      venue: "ST",
      races: [race(1)],
      source_last_updated_at: null,
    });
    const result2 = await preparePushEvent(env, {
      event: "result",
      meeting_date: "2026-10-12",
      venue: "ST",
      races: [race(2)],
      source_last_updated_at: null,
    });
    const div1 = await preparePushEvent(env, {
      event: "dividends",
      meeting_date: "2026-10-12",
      venue: "ST",
      races: [race(1)],
      source_last_updated_at: null,
      meta: { race_nos: [1] },
    });
    const div2 = await preparePushEvent(env, {
      event: "dividends",
      meeting_date: "2026-10-12",
      venue: "ST",
      races: [race(2)],
      source_last_updated_at: null,
      meta: { race_nos: [2] },
    });

    for (const e of [lock1, lock2, result1, result2, div1, div2]) {
      await env.DB.prepare(
        `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
         VALUES (?, ?, 0, '2000-01-01T00:00:00Z', ?, NULL, ?, ?)`,
      )
        .bind(e.event, JSON.stringify(e), new Date().toISOString(), sub.id, e.event_id)
        .run();
    }

    const bodies: PushEnvelope[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as PushEnvelope);
      return new Response("{}", { status: 202 });
    };

    const sent = await flushDueRetries(env, { fetchImpl });
    expect(sent).toBe(6);

    const raceNos = (event: string) =>
      bodies
        .filter((b) => b.event === event)
        .flatMap((b) => b.races.map((r) => r.race_no))
        .sort((a, b) => a - b);

    expect(raceNos("lock")).toEqual([1, 2]);
    expect(raceNos("result")).toEqual([1, 2]);
    expect(raceNos("dividends")).toEqual([1, 2]);
    // No race silently dropped: 2 locks + 2 results + 2 dividends
    expect(bodies.filter((b) => b.event === "lock")).toHaveLength(2);
    expect(bodies.filter((b) => b.event === "result")).toHaveLength(2);
    expect(bodies.filter((b) => b.event === "dividends")).toHaveLength(2);
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
