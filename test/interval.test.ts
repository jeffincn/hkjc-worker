import { describe, expect, it } from "vitest";
import { computePollIntervalMs, selectRelevantPostTime } from "../src/poll/interval";

describe("poll interval by post time", () => {
  const now = Date.parse("2026-10-07T19:00:00+08:00");

  it("uses 60s when more than 30 min before post", () => {
    const ms = computePollIntervalMs({
      nowMs: now,
      postTimeIso: "2026-10-07T20:00:00+08:00",
      fastIntervalSec: 10,
      slowIntervalSec: 60,
    });
    expect(ms).toBe(60_000);
  });

  it("uses fast interval inside 30 min", () => {
    const ms = computePollIntervalMs({
      nowMs: now,
      postTimeIso: "2026-10-07T19:20:00+08:00",
      fastIntervalSec: 10,
      slowIntervalSec: 60,
    });
    expect(ms).toBe(10_000);
  });

  it("uses fast interval at/after post time", () => {
    const ms = computePollIntervalMs({
      nowMs: now,
      postTimeIso: "2026-10-07T18:35:00+08:00",
      fastIntervalSec: 10,
    });
    expect(ms).toBe(10_000);
  });

  it("selects soonest upcoming race", () => {
    const post = selectRelevantPostTime(
      [
        { post_time: "2026-10-07T18:35:00+08:00", status: "RESULT" },
        { post_time: "2026-10-07T19:35:00+08:00", status: "DEFINED" },
        { post_time: "2026-10-07T20:10:00+08:00", status: "DEFINED" },
      ],
      now,
    );
    expect(post).toBe("2026-10-07T19:35:00+08:00");
  });
});
