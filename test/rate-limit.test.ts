import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { preparePushEvent } from "../src/push/emit";
import { enqueueDeliveries, processDeliveryMessage } from "../src/push/queue";
import {
  getRateLimitDelayCount,
  reserveDeliverySlot,
} from "../src/push/rate-limit";
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
  // Dedicated suite: enforce production-like rate of 2/sec.
  env.PUSH_RATE_PER_SUB_PER_SEC = "2";
}

describe("per-subscriber delivery rate limit", () => {
  beforeEach(reset);

  it("allows rate deliveries/sec then delays excess (never drops)", async () => {
    const now = 1_000_000;
    const a = await reserveDeliverySlot(env, 1, now);
    const b = await reserveDeliverySlot(env, 1, now);
    const c = await reserveDeliverySlot(env, 1, now);
    const d = await reserveDeliverySlot(env, 1, now);
    // rate=2 → first two immediate, rest delayed ≥1s (integer delaySeconds)
    expect(a.delaySeconds).toBe(0);
    expect(b.delaySeconds).toBe(0);
    expect(c.delaySeconds).toBeGreaterThanOrEqual(1);
    expect(d.delaySeconds).toBeGreaterThanOrEqual(1);
    expect(await getRateLimitDelayCount(env, 1)).toBeGreaterThanOrEqual(2);
  });

  it("isolates rate clocks per subscriber", async () => {
    const now = 2_000_000;
    const a1 = await reserveDeliverySlot(env, 10, now);
    const b1 = await reserveDeliverySlot(env, 20, now);
    expect(a1.delaySeconds).toBe(0);
    expect(b1.delaySeconds).toBe(0);
  });

  it("direct path defers excess to pending_pushes instead of dropping", async () => {
    const sub = await createSubscriber(env, { url: "https://rate.example/hook" });
    const fetchImpl: typeof fetch = async () => new Response("{}", { status: 202 });
    const target = { subscriber_id: sub.id, url: sub.url, secret: null };

    let immediate = 0;
    let deferred = 0;
    for (let i = 0; i < 5; i++) {
      const envelope = await preparePushEvent(env, {
        event: "test",
        races: [],
        source_last_updated_at: null,
      });
      const outs = await enqueueDeliveries(env, envelope, [target], {
        fetchImpl,
        forceDirect: true,
      });
      if (outs[0]?.deferred_rate_limit) deferred++;
      else if (outs[0]?.success) immediate++;
    }

    expect(immediate).toBeGreaterThanOrEqual(1);
    expect(deferred).toBeGreaterThanOrEqual(1);
    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pending_pushes WHERE last_error LIKE 'rate_limit_delay_%'`,
    ).first<{ n: number }>();
    expect(pending?.n).toBe(deferred);
    // Nothing dropped: immediate HTTP + deferred pending = 5
    expect(immediate + deferred).toBe(5);
  });

  it("queue consumer re-delays when slot not yet reserved", async () => {
    const sub = await createSubscriber(env, { url: "https://qrate.example/hook" });
    const envelope = await preparePushEvent(env, {
      event: "test",
      races: [],
      source_last_updated_at: null,
    });

    // Exhaust the rate clock without marking rate_reserved on the message.
    await reserveDeliverySlot(env, sub.id);
    await reserveDeliverySlot(env, sub.id);
    await reserveDeliverySlot(env, sub.id);

    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return new Response("{}", { status: 202 });
    };

    const result = await processDeliveryMessage(
      env,
      {
        event_id: envelope.event_id,
        subscriber_id: sub.id,
        attempt: 0,
        rate_reserved: false,
      },
      { fetchImpl },
    );
    expect(result.ack).toBe(false);
    expect(result.retryDelaySeconds).toBeGreaterThanOrEqual(1);
    expect(result.rateReserved).toBe(true);
    expect(calls).toBe(0);
  });
});
