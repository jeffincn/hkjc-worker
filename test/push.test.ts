import { describe, expect, it } from "vitest";
import { buildEnvelope, isLivePushEvent } from "../src/push/envelope";
import { hmacSha256Hex, nextBackoffMinutes } from "../src/push/pusher";

describe("push envelope + retry", () => {
  it("builds hkjc-push/1.0 envelope", () => {
    const env = buildEnvelope({
      event: "odds_update",
      meeting_date: "2026-10-07",
      venue: "HV",
      races: [
        {
          race_no: 3,
          post_time: "2026-10-07T19:35:00+08:00",
          snapshot_time: "2026-10-07T19:04:28+08:00",
          pool_status: "START_SELL",
          runners: [
            {
              horse_no: 1,
              horse_name: "EXAMPLE",
              win_odds: 3.5,
              place_odds: 1.8,
              status: "RUNNER",
              final_position: null,
            },
          ],
        },
      ],
    });
    expect(env.schema).toBe("hkjc-push/1.0");
    expect(env.event).toBe("odds_update");
    expect(env.races[0].runners[0].win_odds).toBe(3.5);
    expect(env.sent_at).toMatch(/\+08:00$/);
  });

  it("marks live events for LIVE_PUSH_ENABLED gate", () => {
    expect(isLivePushEvent("odds_update")).toBe(true);
    expect(isLivePushEvent("lock")).toBe(true);
    expect(isLivePushEvent("test")).toBe(false);
    expect(isLivePushEvent("backfill_progress")).toBe(false);
  });

  it("uses exponential backoff 1m/5m/15m", () => {
    expect(nextBackoffMinutes(0)).toBe(1);
    expect(nextBackoffMinutes(1)).toBe(5);
    expect(nextBackoffMinutes(2)).toBe(15);
    expect(nextBackoffMinutes(3)).toBeNull();
  });

  it("computes HMAC signature hex", async () => {
    const sig = await hmacSha256Hex("secret", '{"a":1}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});
