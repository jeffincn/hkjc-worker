import { describe, expect, it } from "vitest";
import { buildRaceOddsSnapshot, parseOddsValue, poolsByRace } from "../src/parse/odds";
import type { PmPoolRaw, RaceRaw } from "../src/graphql/types";

describe("odds parsing", () => {
  it("parses odds strings", () => {
    expect(parseOddsValue("4.0")).toBe(4);
    expect(parseOddsValue("")).toBeNull();
    expect(parseOddsValue(null)).toBeNull();
  });

  it("groups WIN/PLA pools by race", () => {
    const pools: PmPoolRaw[] = [
      {
        oddsType: "WIN",
        sellStatus: "START_SELL",
        leg: { number: 1, races: [1] },
        oddsNodes: [{ combString: "01", oddsValue: "4.0" }],
      },
      {
        oddsType: "PLA",
        sellStatus: "START_SELL",
        leg: { number: 1, races: [1] },
        oddsNodes: [{ combString: "01", oddsValue: "1.8" }],
      },
      {
        oddsType: "WIN",
        sellStatus: "START_SELL",
        leg: { number: 2, races: [2] },
        oddsNodes: [{ combString: "03", oddsValue: "5.5" }],
      },
    ];
    const map = poolsByRace(pools);
    expect(map.get(1)?.win?.oddsNodes?.[0].oddsValue).toBe("4.0");
    expect(map.get(1)?.pla?.oddsNodes?.[0].oddsValue).toBe("1.8");
    expect(map.get(2)?.win?.oddsNodes?.[0].combString).toBe("03");
  });

  it("builds snapshot with win + place odds", () => {
    const race: RaceRaw = {
      no: 1,
      postTime: "2026-10-07T18:35:00+08:00",
      runners: [
        { no: "1", name_en: "A", status: "Ran", finalPosition: 8, winOdds: "4.0" },
        { no: "2", name_en: "B", status: "Ran", finalPosition: 1, winOdds: "11" },
      ],
    };
    const snap = buildRaceOddsSnapshot({
      race,
      winPool: {
        oddsType: "WIN",
        sellStatus: "STOP_SELL",
        lastUpdateTime: "2026-10-07T18:43:31.223+08:00",
        oddsNodes: [
          { combString: "01", oddsValue: "4.0" },
          { combString: "02", oddsValue: "11" },
        ],
      },
      plaPool: {
        oddsType: "PLA",
        sellStatus: "STOP_SELL",
        oddsNodes: [
          { combString: "01", oddsValue: "1.8" },
          { combString: "02", oddsValue: "3.4" },
        ],
      },
    });
    expect(snap.pool_status).toBe("STOP_SELL");
    expect(snap.runners[0].place_odds).toBe(1.8);
    expect(snap.runners[1].win_odds).toBe(11);
    expect(snap.payload.win["1"]).toBe(4);
  });
});
