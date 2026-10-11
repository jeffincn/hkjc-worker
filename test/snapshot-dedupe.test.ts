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

  it("compares against the latest snapshot by snapshot_time, not insert order", async () => {
    const race: RaceRaw = {
      no: 2,
      postTime: "2026-10-07T19:05:00+08:00",
      runners: [{ no: "1", name_en: "A", status: "Declared" }],
    };
    // lastUpdateTime is fixed so the hashed payload only differs by odds;
    // only snapshotTime varies (it is NOT part of the payload hash).
    const mk = (t: string, win: string) =>
      buildRaceOddsSnapshot({
        race,
        snapshotTime: t,
        winPool: {
          oddsType: "WIN",
          sellStatus: "START_SELL",
          lastUpdateTime: "2026-10-07T18:00:00+08:00",
          oddsNodes: [{ combString: "01", oddsValue: win }],
        },
      });

    // Insert a LATER snapshot first (18:05, odds 3.5), then an EARLIER one
    // (18:00, odds 3.2): the earlier one differs from the latest-by-time, so it
    // is still a new snapshot.
    const late = await insertOddsSnapshotIfChanged(
      env.DB,
      "2026-10-07",
      "HV",
      mk("2026-10-07T18:05:00+08:00", "3.5"),
    );
    expect(late.inserted).toBe(true);
    const early = await insertOddsSnapshotIfChanged(
      env.DB,
      "2026-10-07",
      "HV",
      mk("2026-10-07T18:00:00+08:00", "3.2"),
    );
    expect(early.inserted).toBe(true);

    // Same payload as the latest-BY-TIME snapshot (18:05, odds 3.5) must be
    // treated as unchanged even though the most recently INSERTED row is the
    // 18:00 one. Old code (ORDER BY id DESC) got this wrong.
    const dup = await insertOddsSnapshotIfChanged(
      env.DB,
      "2026-10-07",
      "HV",
      mk("2026-10-07T18:00:00+08:00", "3.5"),
    );
    expect(dup.inserted).toBe(false);
    expect(dup.content_hash).toBe(late.content_hash);
  });
});
