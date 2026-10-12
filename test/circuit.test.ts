import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  allowDeliveryAttempt,
  getCircuitSnapshot,
  recordDeliveryFailure,
  recordDeliverySuccess,
} from "../src/push/circuit";
import { buildEnvelope } from "../src/push/envelope";
import { sendPush } from "../src/push/pusher";
import { createSubscriber } from "../src/push/subscribers";

async function reset() {
  for (const t of ["push_subscribers", "pending_pushes", "push_log", "push_events", "worker_meta"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

describe("circuit breaker", () => {
  beforeEach(reset);

  it("opens after N consecutive failures (default 10)", async () => {
    const sub = await createSubscriber(env, { url: "https://cb.example/hook" });
    for (let i = 0; i < 9; i++) {
      const state = await recordDeliveryFailure(env, sub.id, {
        http_status: 500,
        error_message: "HTTP 500",
      });
      expect(state).toBe("closed");
    }
    const opened = await recordDeliveryFailure(env, sub.id, {
      http_status: 500,
      error_message: "HTTP 500",
    });
    expect(opened).toBe("open");

    const snap = await getCircuitSnapshot(env, sub.id);
    expect(snap.circuit_state).toBe("open");
    expect(snap.consecutive_failures).toBe(10);

    const gate = await allowDeliveryAttempt(env, sub.id);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("circuit_open");
  });

  it("opens on repeated 429 before N general failures", async () => {
    const sub = await createSubscriber(env, { url: "https://cb429.example/hook" });
    await recordDeliveryFailure(env, sub.id, { http_status: 429, error_message: "HTTP 429" });
    await recordDeliveryFailure(env, sub.id, { http_status: 429, error_message: "HTTP 429" });
    const state = await recordDeliveryFailure(env, sub.id, {
      http_status: 429,
      error_message: "HTTP 429",
    });
    expect(state).toBe("open");
    expect((await getCircuitSnapshot(env, sub.id)).consecutive_429s).toBe(3);
  });

  it("half-opens after probe window and closes on success", async () => {
    const sub = await createSubscriber(env, { url: "https://probe.example/hook" });
    // Force open with old opened_at
    await env.DB.prepare(
      `UPDATE push_subscribers SET circuit_state='open', consecutive_failures=10,
       circuit_opened_at=? WHERE id=?`,
    )
      .bind(new Date(Date.now() - 6 * 60_000).toISOString(), sub.id)
      .run();

    const gate = await allowDeliveryAttempt(env, sub.id);
    expect(gate.allowed).toBe(true);
    expect(gate.state).toBe("half_open");

    await recordDeliverySuccess(env, sub.id, 202);
    const snap = await getCircuitSnapshot(env, sub.id);
    expect(snap.circuit_state).toBe("closed");
    expect(snap.consecutive_failures).toBe(0);
  });

  it("skips open-circuit subscriber while still delivering to others", async () => {
    const bad = await createSubscriber(env, { url: "https://bad.example/hook" });
    const good = await createSubscriber(env, { url: "https://good.example/hook" });
    await env.DB.prepare(
      `UPDATE push_subscribers SET circuit_state='open', consecutive_failures=10,
       circuit_opened_at=? WHERE id=?`,
    )
      .bind(new Date().toISOString(), bad.id)
      .run();

    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response("{}", { status: 202 });
    };

    const result = await sendPush(env, buildEnvelope({ event: "test", races: [] }), {
      fetchImpl,
      force: true,
      forceDirect: true,
    });

    expect(urls).toEqual(["https://good.example/hook"]);
    expect(result.success).toBe(true);
    const skipped = result.deliveries!.find((d) => d.subscriber_id === bad.id)!;
    expect(skipped.skipped_circuit).toBe(true);
    expect(skipped.success).toBe(false);
  });

  it("never deletes subscribers when circuit opens", async () => {
    const sub = await createSubscriber(env, { url: "https://keep.example/hook" });
    for (let i = 0; i < 10; i++) {
      await recordDeliveryFailure(env, sub.id, { http_status: 500, error_message: "x" });
    }
    const row = await env.DB.prepare(`SELECT id, enabled FROM push_subscribers WHERE id=?`)
      .bind(sub.id)
      .first();
    expect(row).toEqual({ id: sub.id, enabled: 1 });
  });
});
