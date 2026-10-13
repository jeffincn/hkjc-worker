import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { RaceRaw } from "../src/graphql/types";
import {
  buildRaceOddsSnapshot,
  isStandbyRunner,
  resolveRunnerId,
} from "../src/parse/odds";
import {
  buildFullSnapshotCoverageMeta,
  computeOddsDeltaChanges,
  runnersById,
} from "../src/push/delta";
import { buildCompleteSnapshotRaces } from "../src/push/snapshot-coverage";

/**
 * Reproduces production seq326/328: same cloth number on Declared + Standby
 * caused standby to overwrite declared odds when keyed by horse_no alone.
 */
describe("runner_id identity — standby must not steal declared odds", () => {
  it("detects standby via status or empty no + standbyNo", () => {
    expect(
      isStandbyRunner({
        no: "",
        standbyNo: "5",
        status: "Standby",
        name_en: "RESERVE",
      }),
    ).toBe(true);
    expect(
      isStandbyRunner({
        no: "5",
        status: "Declared",
        name_en: "MAIN",
        horse: { code: "H001" },
      }),
    ).toBe(false);
  });

  it("resolveRunnerId prefers horse.code and never collides Declared vs Standby", () => {
    expect(
      resolveRunnerId(
        { no: "5", horse: { code: "H001" }, status: "Declared" },
        5,
        "Declared",
      ),
    ).toBe("H001");
    expect(
      resolveRunnerId(
        { no: "", standbyNo: "5", status: "Standby", horse: { code: "H999" } },
        5,
        "Standby",
      ),
    ).toBe("H999");
    expect(resolveRunnerId({ no: "5" }, 5, "Declared")).toBe("no:5");
    expect(resolveRunnerId({ no: "", standbyNo: "5" }, 5, "Standby")).toBe(
      "standby:5",
    );
  });

  it("buildRaceOddsSnapshot: declared keeps pool odds; same-number standby does not", () => {
    const race: RaceRaw = {
      no: 3,
      postTime: "2026-10-07T20:00:00+08:00",
      runners: [
        {
          no: "5",
          status: "Declared",
          name_en: "DECLARED_FIVE",
          horse: { code: "D005", id: "hid-d5" },
        },
        {
          no: "",
          standbyNo: "5",
          status: "Standby",
          name_en: "STANDBY_FIVE",
          horse: { code: "S005", id: "hid-s5" },
        },
        {
          no: "6",
          status: "Declared",
          name_en: "DECLARED_SIX",
          horse: { code: "D006" },
        },
        {
          no: "",
          standbyNo: "6",
          status: "Standby",
          name_en: "STANDBY_SIX",
          horse: { code: "S006" },
        },
      ],
    };
    const snap = buildRaceOddsSnapshot({
      race,
      winPool: {
        oddsType: "WIN",
        sellStatus: "START_SELL",
        lastUpdateTime: "2026-10-07T19:00:00+08:00",
        oddsNodes: [
          { combString: "05", oddsValue: "4.5" },
          { combString: "06", oddsValue: "8.0" },
        ],
      },
      plaPool: {
        oddsType: "PLA",
        sellStatus: "START_SELL",
        lastUpdateTime: "2026-10-07T19:00:00+08:00",
        oddsNodes: [
          { combString: "05", oddsValue: "1.9" },
          { combString: "06", oddsValue: "2.8" },
        ],
      },
    });

    const byId = runnersById(snap.runners);
    expect(byId.size).toBe(4);

    const d5 = byId.get("D005")!;
    const s5 = byId.get("S005")!;
    expect(d5.status).toBe("Declared");
    expect(d5.horse_no).toBe(5);
    expect(d5.win_odds).toBe(4.5);
    expect(d5.place_odds).toBe(1.9);

    expect(s5.status).toBe("Standby");
    expect(s5.horse_no).toBe(5);
    // Standby must NOT inherit declared cloth pool odds.
    expect(s5.win_odds).toBeNull();
    expect(s5.place_odds).toBeNull();

    expect(byId.get("D006")!.win_odds).toBe(8);
    expect(byId.get("S006")!.win_odds).toBeNull();
  });

  it("delta changes attribute WIN/PLA to declared runner_id, not standby (seq326/328)", () => {
    const race: RaceRaw = {
      no: 1,
      runners: [
        {
          no: "5",
          status: "Declared",
          name_en: "ALPHA",
          horse: { code: "HALPHA" },
        },
        {
          no: "",
          standbyNo: "5",
          status: "Standby",
          name_en: "BETA_SB",
          horse: { code: "HBETASB" },
        },
      ],
    };
    const prev = buildRaceOddsSnapshot({
      race,
      winPool: {
        oddsType: "WIN",
        sellStatus: "START_SELL",
        lastUpdateTime: "2026-10-07T18:00:00+08:00",
        oddsNodes: [{ combString: "05", oddsValue: "5.0" }],
      },
      plaPool: {
        oddsType: "PLA",
        sellStatus: "START_SELL",
        lastUpdateTime: "2026-10-07T18:00:00+08:00",
        oddsNodes: [{ combString: "05", oddsValue: "2.0" }],
      },
    });
    const next = buildRaceOddsSnapshot({
      race,
      winPool: {
        oddsType: "WIN",
        sellStatus: "START_SELL",
        lastUpdateTime: "2026-10-07T18:00:03+08:00",
        oddsNodes: [{ combString: "05", oddsValue: "4.2" }],
      },
      plaPool: {
        oddsType: "PLA",
        sellStatus: "START_SELL",
        lastUpdateTime: "2026-10-07T18:00:03+08:00",
        oddsNodes: [{ combString: "05", oddsValue: "1.7" }],
      },
    });

    const changes = computeOddsDeltaChanges({ prev, next });
    // Only declared horse odds changed — 2 rows (WIN+PLA), never standby.
    expect(changes).toHaveLength(2);
    for (const c of changes) {
      expect(c.runner_id).toBe("HALPHA");
      expect(c.horse_no).toBe(5);
      expect(c.horse_name).toBe("ALPHA");
      expect(c.status).toBe("Declared");
      expect(c.pool).toBe(c.bet_type);
      expect(["WIN", "PLA"]).toContain(c.pool);
    }
    expect(changes.some((c) => c.runner_id === "HBETASB")).toBe(false);
    expect(changes.some((c) => c.status === "Standby")).toBe(false);

    // Old horse_no-keyed collapse would have produced standby-named rows or
    // dropped declared — assert declared name preserved.
    expect(changes.every((c) => c.horse_name_en === "ALPHA")).toBe(true);
  });
});

describe("full snapshot coverage — incomplete races (seq327/329)", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM odds_snapshots`).run();
  });

  it("reports covered_races / missing_races / race_source_ts (+08:00)", () => {
    const meta = buildFullSnapshotCoverageMeta({
      expectedRaceNos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      races: [
        {
          race_no: 1,
          post_time: null,
          snapshot_time: "t",
          pool_status: "START_SELL",
          source_last_updated_at: "2026-10-07T19:00:00+08:00",
          source_ts: "2026-10-07T19:00:00+08:00",
          runners: [],
        },
        {
          race_no: 2,
          post_time: null,
          snapshot_time: "t",
          pool_status: "START_SELL",
          source_last_updated_at: "2026-10-07T19:01:00+08:00",
          runners: [],
        },
        // R3 missing — reproduces seq329
        {
          race_no: 4,
          post_time: null,
          snapshot_time: "t",
          pool_status: "START_SELL",
          source_last_updated_at: null,
          runners: [],
        },
      ],
    });
    expect(meta.covered_races).toEqual([1, 2, 4]);
    expect(meta.missing_races).toContain(3);
    expect(meta.missing_races).toEqual([3, 5, 6, 7, 8, 9, 10]);
    expect(meta.race_source_ts["1"]).toMatch(/\+08:00$/);
    expect(meta.race_source_ts["3"]).toBeNull();
  });

  it("fills dropped races from D1 so odds_update is meeting-complete", async () => {
    // Simulate: live tick only has R1,R2 (old bug: emit only changed/due subset).
    // R3 already stored in D1 from an earlier tick — must be filled back in.
    const r3 = buildRaceOddsSnapshot({
      race: {
        no: 3,
        postTime: "2026-10-07T19:35:00+08:00",
        runners: [
          {
            no: "1",
            status: "Declared",
            name_en: "R3ONE",
            horse: { code: "HR3" },
          },
        ],
      },
      winPool: {
        oddsType: "WIN",
        sellStatus: "START_SELL",
        lastUpdateTime: "2026-10-07T18:50:00+08:00",
        oddsNodes: [{ combString: "01", oddsValue: "3.0" }],
      },
    });
    await env.DB.prepare(
      `INSERT INTO odds_snapshots
       (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "2026-10-07",
        "ST",
        3,
        r3.snapshot_time,
        "hash-r3",
        r3.pool_status,
        JSON.stringify(r3),
        "graphql",
        new Date().toISOString(),
      )
      .run();

    const liveOnly = [1, 2, 4, 5, 6, 7, 8].map((n) => ({
      race_no: n,
      post_time: null,
      snapshot_time: "2026-10-07T19:00:00+08:00",
      pool_status: "START_SELL",
      source_last_updated_at: "2026-10-07T19:00:00+08:00",
      runners: [],
    }));

    const { races, meta } = await buildCompleteSnapshotRaces({
      env,
      meeting_date: "2026-10-07",
      venue: "ST",
      expectedRaceNos: [1, 2, 3, 4, 5, 6, 7, 8],
      available: liveOnly,
    });

    expect(races.map((r) => r.race_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(meta.covered_races).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(meta.missing_races).toEqual([]);
    const filled = races.find((r) => r.race_no === 3)!;
    expect(filled.runners[0]?.runner_id).toBe("HR3");
    expect(filled.source_ts).toMatch(/\+08:00$/);
  });
});
