import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PmPoolRaw } from "../src/graphql/types";
import {
  applyWinCombWinnerFallback,
  positionsUnresolved,
  shouldApplyWinCombFallback,
  winCombWinnerHorseNos,
} from "../src/parse/dividends";
import { normalizeRunner } from "../src/parse/meeting";
import {
  applyWinCombPositionFallback,
  storeDividendsAsResults,
} from "../src/store/db";

function officialWinPools(
  winCombs: string | string[],
  status = "OFFICIAL",
): PmPoolRaw[] {
  const combs = Array.isArray(winCombs) ? winCombs : [winCombs];
  return [
    {
      oddsType: "WIN",
      status,
      leg: { number: 1, races: [1] },
      dividends: combs.map((winComb, i) => ({
        winComb,
        div: i === 0 ? "42" : "42",
        status: "OFFICIAL",
      })),
    },
    {
      oddsType: "PLA",
      status,
      leg: { number: 1, races: [1] },
      dividends: [
        { winComb: "11", div: "18.5" },
        { winComb: combs[0]!, div: "13.0" },
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
      dead_heat: null as boolean | null,
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
    expect(result.dead_heat).toBe(false);
    expect(runners.find((r) => r.horse_no === 1)?.final_position).toBe(1);
    expect(runners.find((r) => r.horse_no === 1)?.dead_heat).toBeNull();
    expect(runners.filter((r) => r.horse_no !== 1).every((r) => r.final_position == null)).toBe(
      true,
    );
  });

  it("multi WIN winComb (dead heat) → each winner final_position=1 and dead_heat=true", () => {
    const runners = [1, 2, 3, 7].map((horse_no) => ({
      horse_no,
      final_position: null as number | null,
      dead_heat: null as boolean | null,
    }));
    const pools = officialWinPools(["3", "7"]);
    expect(winCombWinnerHorseNos(pools)).toEqual([3, 7]);

    const result = applyWinCombWinnerFallback({ runners, pools });
    expect(result.applied).toBe(true);
    expect(result.winners).toEqual([3, 7]);
    expect(result.dead_heat).toBe(true);
    expect(runners.find((r) => r.horse_no === 3)).toMatchObject({
      final_position: 1,
      dead_heat: true,
    });
    expect(runners.find((r) => r.horse_no === 7)).toMatchObject({
      final_position: 1,
      dead_heat: true,
    });
    expect(runners.find((r) => r.horse_no === 1)?.final_position).toBeNull();
    expect(runners.find((r) => r.horse_no === 1)?.dead_heat).toBeNull();
  });

  it("winner already present (final_position=1) → no-op", () => {
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
    expect(result.reason).toBe("winner_already_present");
    expect(runners[0]!.final_position).toBe(3);
    expect(runners[1]!.final_position).toBe(1);
  });

  it("no usable dividends → keep unresolved and warn (R5)", async () => {
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
    expect(msg).toMatch(/final_position=1 missing|final_position unresolved/);
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
      `SELECT final_position, dead_heat FROM results
       WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=1`,
    )
      .bind("2026-10-14", "HV", 1)
      .first<{ final_position: number | null; dead_heat: number | null }>();
    expect(winner?.final_position).toBe(1);
    expect(winner?.dead_heat == null || winner?.dead_heat === 0).toBe(true);

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

  it("storeDividendsAsResults multi winComb sets dead_heat=1 on each winner", async () => {
    const now = new Date().toISOString();
    for (const horse of [3, 5, 7]) {
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
      officialWinPools(["3", "7"]),
      "graphql",
    );

    const { results } = await env.DB.prepare(
      `SELECT horse_no, final_position, dead_heat FROM results
       WHERE meeting_date=? AND venue=? AND race_no=?
       ORDER BY horse_no`,
    )
      .bind("2026-10-14", "HV", 1)
      .all<{ horse_no: number; final_position: number | null; dead_heat: number | null }>();

    const byNo = new Map((results ?? []).map((r) => [r.horse_no, r]));
    expect(byNo.get(3)).toMatchObject({ final_position: 1, dead_heat: 1 });
    expect(byNo.get(7)).toMatchObject({ final_position: 1, dead_heat: 1 });
    expect(byNo.get(5)?.final_position === 0 || byNo.get(5)?.final_position == null).toBe(
      true,
    );
    expect(byNo.get(5)?.dead_heat == null || byNo.get(5)?.dead_heat === 0).toBe(true);
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

describe("WIN winComb fallback gate (issue #31)", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `DELETE FROM results WHERE meeting_date=? AND venue=?`,
    )
      .bind("2026-10-14", "HV")
      .run();
  });

  /** Real production shape: #1/#2 missing, #3–#12 hold places 2–11. */
  function partialMissingRunners(): Array<{
    horse_no: number;
    final_position: number | null;
    dead_heat: boolean | null;
  }> {
    return Array.from({ length: 12 }, (_, i) => {
      const horse_no = i + 1;
      let final_position: number | null = null;
      if (horse_no >= 3) final_position = horse_no - 1; // 3→2 … 12→11
      return { horse_no, final_position, dead_heat: null };
    });
  }

  it("A1: [null,null,2..11] + winComb=[1] → #1=1, others untouched, applied=true", () => {
    const runners = partialMissingRunners();
    expect(shouldApplyWinCombFallback(runners.map((r) => r.final_position))).toBe(
      true,
    );
    expect(positionsUnresolved(runners.map((r) => r.final_position))).toBe(false);

    const result = applyWinCombWinnerFallback({
      runners,
      pools: officialWinPools("1"),
    });
    expect(result.applied).toBe(true);
    expect(result.winners).toEqual([1]);
    expect(runners.find((r) => r.horse_no === 1)?.final_position).toBe(1);
    expect(runners.find((r) => r.horse_no === 2)?.final_position).toBeNull();
    for (let horse = 3; horse <= 12; horse++) {
      expect(runners.find((r) => r.horse_no === horse)?.final_position).toBe(
        horse - 1,
      );
    }
  });

  it("A2: complete [1..11] + winComb=[1] → applied=false no-op", () => {
    const runners = Array.from({ length: 11 }, (_, i) => ({
      horse_no: i + 1,
      final_position: i + 1,
      dead_heat: null as boolean | null,
    }));
    expect(shouldApplyWinCombFallback(runners.map((r) => r.final_position))).toBe(
      false,
    );

    const result = applyWinCombWinnerFallback({
      runners,
      pools: officialWinPools("1"),
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("winner_already_present");
    expect(runners.map((r) => r.final_position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it("A3: all null + winComb=[5] → applied=true (PR #30 regression)", () => {
    const runners = Array.from({ length: 12 }, (_, i) => ({
      horse_no: i + 1,
      final_position: null as number | null,
      dead_heat: null as boolean | null,
    }));
    const result = applyWinCombWinnerFallback({
      runners,
      pools: officialWinPools("5"),
    });
    expect(result.applied).toBe(true);
    expect(result.winners).toEqual([5]);
    expect(runners.find((r) => r.horse_no === 5)?.final_position).toBe(1);
    expect(
      runners.filter((r) => r.horse_no !== 5).every((r) => r.final_position == null),
    ).toBe(true);
  });

  it("A4: [null,null,2..11] + no WIN → applied=false + warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = new Date().toISOString();
    for (const r of partialMissingRunners()) {
      await env.DB.prepare(
        `INSERT INTO results (meeting_date, venue, race_no, horse_no, final_position, dead_heat, win_odds, place_odds, dividends_json, data_source, updated_at)
         VALUES ('2026-10-14', 'HV', 1, ?, ?, NULL, NULL, NULL, NULL, 'graphql', ?)`,
      )
        .bind(r.horse_no, r.final_position, now)
        .run();
    }

    const out = await applyWinCombPositionFallback(
      env.DB,
      "2026-10-14",
      "HV",
      1,
      [
        {
          oddsType: "PLA",
          status: "OFFICIAL",
          dividends: [
            { winComb: "11", div: "18.5" },
            { winComb: "1", div: "13.0" },
          ],
        },
      ],
      "graphql",
    );
    expect(out.applied).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain(
      "final_position=1 missing",
    );
    warn.mockRestore();

    const one = await env.DB.prepare(
      `SELECT final_position FROM results WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=1`,
    )
      .bind("2026-10-14", "HV", 1)
      .first<{ final_position: number | null }>();
    expect(one?.final_position == null || one?.final_position === 0).toBe(true);
  });

  it("A1 db path: partial missing + winComb=[1] sets only #1", async () => {
    const now = new Date().toISOString();
    for (const r of partialMissingRunners()) {
      await env.DB.prepare(
        `INSERT INTO results (meeting_date, venue, race_no, horse_no, final_position, dead_heat, win_odds, place_odds, dividends_json, data_source, updated_at)
         VALUES ('2026-10-14', 'HV', 1, ?, ?, NULL, NULL, NULL, NULL, 'graphql', ?)`,
      )
        .bind(r.horse_no, r.final_position, now)
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

    const { results } = await env.DB.prepare(
      `SELECT horse_no, final_position FROM results
       WHERE meeting_date=? AND venue=? AND race_no=?
       ORDER BY horse_no`,
    )
      .bind("2026-10-14", "HV", 1)
      .all<{ horse_no: number; final_position: number | null }>();
    const byNo = new Map((results ?? []).map((r) => [r.horse_no, r.final_position]));
    expect(byNo.get(1)).toBe(1);
    expect(byNo.get(2) == null || byNo.get(2) === 0).toBe(true);
    expect(byNo.get(3)).toBe(2);
    expect(byNo.get(12)).toBe(11);
  });
});
