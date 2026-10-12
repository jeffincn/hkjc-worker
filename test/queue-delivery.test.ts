import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { preparePushEvent } from "../src/push/emit";
import {
  enqueueDeliveries,
  hasPushQueue,
  processDeliveryMessage,
  queueRetryDelaySeconds,
} from "../src/push/queue";
import { createSubscriber } from "../src/push/subscribers";

async function reset() {
  for (const t of ["push_subscribers", "pending_pushes", "push_log", "push_events", "push_seq", "worker_meta"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

describe("queue delivery decoupling", () => {
  beforeEach(reset);

  it("uses direct send when forceDirect even if queue binding exists", async () => {
    // wrangler.toml template binds PUSH_QUEUE; local/tests still support
    // forceDirect so HTTP delivery can be asserted without the consumer.
    expect(typeof hasPushQueue(env)).toBe("boolean");
    const sub = await createSubscriber(env, { url: "https://direct.example/hook" });
    const envelope = await preparePushEvent(env, {
      event: "test",
      races: [],
      source_last_updated_at: null,
    });
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return new Response("{}", { status: 202 });
    };
    await enqueueDeliveries(
      env,
      envelope,
      [{ subscriber_id: sub.id, url: sub.url, secret: null }],
      { fetchImpl, forceDirect: true },
    );
    expect(calls).toBe(1);
  });

  it("direct-sends when queue absent and keeps same event_id on retry enqueue", async () => {
    const sub = await createSubscriber(env, { url: "https://q.example/hook" });
    const envelope = await preparePushEvent(env, {
      event: "test",
      meeting_date: "2026-10-12",
      venue: "ST",
      races: [],
      source_last_updated_at: null,
    });

    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return new Response("fail", { status: 500 });
    };

    const deliveries = await enqueueDeliveries(
      env,
      envelope,
      [{ subscriber_id: sub.id, url: sub.url, secret: null }],
      { fetchImpl, forceDirect: true },
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.success).toBe(false);
    expect(calls).toBe(1);

    const pending = await env.DB.prepare(
      `SELECT event_id, subscriber_id FROM pending_pushes`,
    ).first<{ event_id: string; subscriber_id: number }>();
    expect(pending?.event_id).toBe(envelope.event_id);
    expect(pending?.subscriber_id).toBe(sub.id);
  });

  it("queue consumer reloads body from push_events ledger", async () => {
    const sub = await createSubscriber(env, { url: "https://consumer.example/hook" });
    const envelope = await preparePushEvent(env, {
      event: "odds_update",
      meeting_date: "2026-10-12",
      venue: "HV",
      races: [],
      source_last_updated_at: null,
    });

    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("{}", { status: 202 });
    };

    const result = await processDeliveryMessage(
      env,
      { event_id: envelope.event_id, subscriber_id: sub.id, attempt: 0 },
      { fetchImpl },
    );
    expect(result.ack).toBe(true);
    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(bodies[0]!);
    expect(parsed.event_id).toBe(envelope.event_id);
    expect(parsed.event).toBe("odds_update");
  });

  it("uses backoff delays for queue retries", () => {
    expect(queueRetryDelaySeconds(0)).toBe(60);
    expect(queueRetryDelaySeconds(1)).toBe(300);
    expect(queueRetryDelaySeconds(2)).toBe(900);
  });

  it("mock queue binding enqueues per subscriber without HTTP in producer", async () => {
    const a = await createSubscriber(env, { url: "https://qa.example/a" });
    const b = await createSubscriber(env, { url: "https://qb.example/b" });
    const envelope = await preparePushEvent(env, {
      event: "test",
      races: [],
      source_last_updated_at: null,
    });

    const sent: unknown[] = [];
    const mockQueue = {
      send: async (msg: unknown) => {
        sent.push(msg);
      },
    };
    const envWithQueue = { ...env, PUSH_QUEUE: mockQueue as unknown as Queue };

    let httpCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      httpCalls++;
      return new Response("{}", { status: 202 });
    };

    const deliveries = await enqueueDeliveries(
      envWithQueue,
      envelope,
      [
        { subscriber_id: a.id, url: a.url, secret: null },
        { subscriber_id: b.id, url: b.url, secret: null },
      ],
      { fetchImpl },
    );

    expect(sent).toHaveLength(2);
    expect(httpCalls).toBe(0);
    expect(deliveries.every((d) => d.queued && d.success)).toBe(true);
    expect(sent[0]).toMatchObject({ event_id: envelope.event_id, subscriber_id: a.id });
    expect(sent[1]).toMatchObject({ event_id: envelope.event_id, subscriber_id: b.id });
  });
});
