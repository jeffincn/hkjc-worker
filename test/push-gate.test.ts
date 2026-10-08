import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildEnvelope } from "../src/push/envelope";
import { sendPush } from "../src/push/pusher";

describe("LIVE_PUSH_ENABLED gate", () => {
  it("skips live events when gate is false and never calls webhook", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("nope", { status: 500 });
    };
    const result = await sendPush(
      env,
      buildEnvelope({
        event: "odds_update",
        meeting_date: "2026-10-07",
        venue: "HV",
        races: [],
      }),
      { fetchImpl },
    );
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("LIVE_PUSH_ENABLED");
    expect(called).toBe(false);
  });

  it("skips when no subscribers and PUSH_TARGET_URL missing even for test", async () => {
    await env.DB.prepare(`DELETE FROM push_subscribers`).run();
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("{}", { status: 202 });
    };
    const result = await sendPush(
      env,
      buildEnvelope({ event: "test", races: [] }),
      { fetchImpl, force: true },
    );
    expect(result.skipped).toBe(true);
    expect(called).toBe(false);
  });
});
