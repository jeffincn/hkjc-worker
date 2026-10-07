import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildRaceOddsSnapshot } from "../src/parse/odds";
import { insertOddsSnapshotIfChanged } from "../src/store/db";
import type { RaceRaw } from "../src/graphql/types";

describe("odds snapshot hash dedupe", () => {
  it("inserts once for identical payload", async () => {
    const race: RaceRaw = {
      no: 1,
      postTime: "2026-10-07T18:35:00+08:00",
      runners: [{ no: "1", name_en: "A", status: "Declared" }],
    };
    const snap = buildRaceOddsSnapshot({
      race,
      winPool: {
        oddsType: "WIN",
        sellStatus: "START_SELL",
        lastUpdateTime: "2026-10-07T18:00:00+08:00",
        oddsNodes: [{ combString: "01", oddsValue: "3.5" }],
      },
      plaPool: {
        oddsType: "PLA",
        sellStatus: "START_SELL",
        oddsNodes: [{ combString: "01", oddsValue: "1.5" }],
      },
    });

    const a = await insertOddsSnapshotIfChanged(env.DB, "2026-10-07", "HV", snap);
    const b = await insertOddsSnapshotIfChanged(env.DB, "2026-10-07", "HV", snap);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(a.content_hash).toBe(b.content_hash);

    const snap2 = buildRaceOddsSnapshot({
      race,
      winPool: {
        oddsType: "WIN",
        sellStatus: "START_SELL",
        lastUpdateTime: "2026-10-07T18:01:00+08:00",
        oddsNodes: [{ combString: "01", oddsValue: "3.2" }],
      },
      plaPool: {
        oddsType: "PLA",
        sellStatus: "START_SELL",
        oddsNodes: [{ combString: "01", oddsValue: "1.4" }],
      },
    });
    const c = await insertOddsSnapshotIfChanged(env.DB, "2026-10-07", "HV", snap2);
    expect(c.inserted).toBe(true);
    expect(c.content_hash).not.toBe(a.content_hash);
  });
});
