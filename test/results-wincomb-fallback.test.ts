import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PmPoolRaw } from "../src/graphql/types";
import {
  applyWinCombWinnerFallback,
  positionsUnresolved,
  winCombWinnerHorseNos,
} from "../src/parse/dividends";
import { normalizeRunner } from "../src/parse/meeting";
import {
  applyWinCombPositionFallback,
  storeDividendsAsResults,
} from "../src/store/db";

function officialWinPools(winComb: string, status = "OFFICIAL"): PmPoolRaw[] {
  return [
    {
      oddsType: "WIN",
      status,
      leg: { number: 1, races: [1] },
      dividends: [{ winComb, div: "42", status: "OFFICIAL" }],
    },
    {
      oddsType: "PLA",
      status,
      leg: { number: 1, races: [1] },
      dividends: [
        { winComb: "11", div: "18.5" },
        { winComb, div: "13.0" },
        { winComb: "12", div: "22.0" },
      ],
    },
  ];
}

describe("WIN winComb → final_position fallback (issue #29)", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `DELETE FROM results WHERE meeting_date=? AND venue=?`,
    )
      .bind("2026-10-14", "HV")
      .run();
  });

  it("A3: all final_position 0 + WIN winComb → winner horse_no=1 gets position 1", () => {
    const runners = Array.from({ length: 12 }, (_, i) => ({
      horse_no: i + 1,
      final_position: 0 as number | null,
    }));
    // Simulate normalizeRunner coercing 0 → null
    for (const r of runners) {
      if (r.final_position != null && r.final_position <= 0) {
        r.final_position = null;
      }
    }
    const pools = officialWinPools("1");
    expect(winCombWinnerHorseNos(pools)).toEqual([1]);
    expect(positionsUnresolved(runners.map((r) => r.final_position))).toBe(true);

    const result = applyWinCombWinnerFallback({ runners, pools });
    expect(result.applied).toBe(true);
    expect(result.winners).toEqual([1]);
    expect(runners.find((r) => r.horse_no === 1)?.final_position).toBe(1);
    expect(runners.filter((r) => r.horse_no !== 1).every((r) => r.final_position == null)).toBe(
      true,
    );
  });

  it("A3: official positions present → do not use dividends fallback (R3)", () => {
    const runners = [
      { horse_no: 1, final_position: 3 },
      { horse_no: 2, final_position: 1 },
      { horse_no: 3, final_position: 2 },
    ];
    const result = applyWinCombWinnerFallback({
      runners,
      pools: officialWinPools("1"),
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("official_positions_present");
    expect(runners[0]!.final_position).toBe(3);
    expect(runners[1]!.final_position).toBe(1);
  });

  it("A3: no usable dividends → keep unresolved and warn (R2)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await env.DB.prepare(
      `INSERT INTO results (meeting_date, venue, race_no, horse_no, final_position, dead_heat, win_odds, place_odds, dividends_json, data_source, updated_at)
       VALUES ('2026-10-14', 'HV', 1, 1, 0, NULL, NULL, NULL, NULL, 'graphql', ?),
              ('2026-10-14', 'HV', 1, 2, 0, NULL, NULL, NULL, NULL, 'graphql', ?)`,
    )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run();

    const out = await applyWinCombPositionFallback(
      env.DB,
      "2026-10-14",
      "HV",
      1,
      [
        {
          oddsType: "PLA",
          status: "OFFICIAL",
          dividends: [{ winComb: "1", div: "10" }],
        },
      ],
      "graphql",
    );
    expect(out.applied).toBe(false);
    expect(warn).toHaveBeenCalled();
    const msg = String(warn.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("final_position unresolved");
    warn.mockRestore();

    const row = await env.DB.prepare(
      `SELECT final_position FROM results WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=1`,
    )
      .bind("2026-10-14", "HV", 1)
      .first<{ final_position: number | null }>();
    expect(row?.final_position === 0 || row?.final_position == null).toBe(true);
  });

  it("normalizeRunner coerces finalPosition=0 to null", () => {
    const r = normalizeRunner({
      no: "1",
      finalPosition: 0,
      status: "Ran",
    });
    expect(r.final_position).toBeNull();
  });

  it("storeDividendsAsResults sets winner final_position=1 for 2026-10-14 HV R1 shape", async () => {
    // Pre-seed all-zero positions like production bug
    const now = new Date().toISOString();
    for (let horse = 1; horse <= 12; horse++) {
      await env.DB.prepare(
        `INSERT INTO results (meeting_date, venue, race_no, horse_no, final_position, dead_heat, win_odds, place_odds, dividends_json, data_source, updated_at)
         VALUES ('2026-10-14', 'HV', 1, ?, 0, NULL, NULL, NULL, NULL, 'graphql', ?)`,
      )
        .bind(horse, now)
        .run();
    }

    await storeDividendsAsResults(
      env.DB,
      "2026-10-14",
      "HV",
      1,
      officialWinPools("1"),
      "graphql",
    );

    const winner = await env.DB.prepare(
      `SELECT final_position FROM results
       WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=1`,
    )
      .bind("2026-10-14", "HV", 1)
      .first<{ final_position: number | null }>();
    expect(winner?.final_position).toBe(1);

    const others = await env.DB.prepare(
      `SELECT horse_no, final_position FROM results
       WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no!=1`,
    )
      .bind("2026-10-14", "HV", 1)
      .all<{ horse_no: number; final_position: number | null }>();
    expect(
      (others.results ?? []).every(
        (r) => r.final_position == null || r.final_position === 0,
      ),
    ).toBe(true);
  });

  it("does not overwrite an existing official winner with a different winComb", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO results (meeting_date, venue, race_no, horse_no, final_position, dead_heat, win_odds, place_odds, dividends_json, data_source, updated_at)
       VALUES ('2026-10-14', 'HV', 1, 5, 1, NULL, NULL, NULL, NULL, 'graphql', ?),
              ('2026-10-14', 'HV', 1, 1, 2, NULL, NULL, NULL, NULL, 'graphql', ?)`,
    )
      .bind(now, now)
      .run();

    await storeDividendsAsResults(
      env.DB,
      "2026-10-14",
      "HV",
      1,
      officialWinPools("1"),
      "graphql",
    );

    const five = await env.DB.prepare(
      `SELECT final_position FROM results WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=5`,
    )
      .bind("2026-10-14", "HV", 1)
      .first<{ final_position: number }>();
    const one = await env.DB.prepare(
      `SELECT final_position FROM results WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=1`,
    )
      .bind("2026-10-14", "HV", 1)
      .first<{ final_position: number }>();
    expect(five?.final_position).toBe(1);
    expect(one?.final_position).toBe(2);
  });
});
