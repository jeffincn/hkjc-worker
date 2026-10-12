import { describe, expect, it } from "vitest";
import {
  buildEnvelope,
  buildQuality,
  computeLateMs,
  isLivePushEvent,
  ODDS_BASIS,
} from "../src/push/envelope";
import { hmacSha256Hex, nextBackoffMinutes } from "../src/push/pusher";

describe("push envelope + retry", () => {
  it("builds hkjc-push/1.1 envelope with required fields", () => {
    const env = buildEnvelope({
      event: "odds_update",
      meeting_date: "2026-10-07",
      venue: "HV",
      event_id: "00000000-0000-4000-8000-000000000001",
      seq: 1,
      captured_at: "2026-10-07T19:04:28+08:00",
      sent_at: "2026-10-07T19:04:30+08:00",
      source_last_updated_at: "2026-10-07T19:04:28+08:00",
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
    expect(env.schema).toBe("hkjc-push/1.1");
    expect(env.event).toBe("odds_update");
    expect(env.event_id).toBe("00000000-0000-4000-8000-000000000001");
    expect(env.seq).toBe(1);
    expect(env.captured_at).toMatch(/\+08:00$/);
    expect(env.sent_at).toMatch(/\+08:00$/);
    expect(env.source.name).toBe("HKJC GraphQL");
    expect(env.source.url).toContain("graphql");
    expect(env.source.last_updated_at).toBe("2026-10-07T19:04:28+08:00");
    expect(env.quality.missing_source_time).toBe(false);
    expect(env.quality.post_start).toBe(false);
    expect(env.quality.late_ms).toBe(2000);
    expect(env.races[0].runners[0].win_odds).toBe(3.5);
  });

  it("sets source.last_updated_at explicitly null and flags missing_source_time", () => {
    const env = buildEnvelope({
      event: "test",
      event_id: "00000000-0000-4000-8000-000000000002",
      seq: 1,
      source_last_updated_at: null,
      races: [],
    });
    expect(env.source.last_updated_at).toBeNull();
    expect(env.quality.missing_source_time).toBe(true);
    expect("last_updated_at" in env.source).toBe(true);
  });

  it("flags post_start when race post_time is already past captured_at", () => {
    const q = buildQuality({
      source_last_updated_at: "2026-10-07T19:40:00+08:00",
      captured_at: "2026-10-07T19:40:00+08:00",
      sent_at: "2026-10-07T19:40:01+08:00",
      races: [{ post_time: "2026-10-07T19:35:00+08:00" }],
    });
    expect(q.post_start).toBe(true);
    expect(computeLateMs("2026-10-07T19:40:00+08:00", "2026-10-07T19:40:01+08:00")).toBe(
      1000,
    );
  });

  it("documents HKJC odds basis as total return per $1 incl. stake", () => {
    expect(ODDS_BASIS).toBe("HKD total return per $1 unit incl. stake");
  });

  it("marks live events for LIVE_PUSH_ENABLED gate", () => {
    expect(isLivePushEvent("odds_update")).toBe(true);
    expect(isLivePushEvent("odds_delta")).toBe(true);
    expect(isLivePushEvent("no_update")).toBe(true);
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
