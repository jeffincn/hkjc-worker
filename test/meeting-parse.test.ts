import { describe, expect, it } from "vitest";
import {
  filterLocalMeetings,
  isScratchedStatus,
  normalizeBackfillMeeting,
  normalizeMeeting,
  resultsComplete,
} from "../src/parse/meeting";
import type { MeetingRaw } from "../src/graphql/types";

describe("meeting parse", () => {
  it("skips simulcast S1–S5 venues", () => {
    const filtered = filterLocalMeetings([
      { venueCode: "HV", date: "2026-10-07" },
      { venueCode: "S1", date: "2026-10-09" },
      { venueCode: "ST", date: "2026-10-04" },
      { venueCode: "S5", date: "2026-10-10" },
    ]);
    expect(filtered.map((m) => m.venueCode)).toEqual(["HV", "ST"]);
  });

  it("normalizes live meeting fields", () => {
    const raw: MeetingRaw = {
      date: "2026-10-07",
      venueCode: "HV",
      status: "CLOSED",
      totalNumberOfRace: 9,
      races: [
        {
          no: 1,
          postTime: "2026-10-07T18:35:00+08:00",
          status: "RESULT",
          distance: 1800,
          go_en: "GOOD TO FIRM",
          raceCourse: { description_en: "C+3 COURSE", displayCode: "C+3" },
          raceClass_en: "Class 5",
          runners: [
            {
              no: "1",
              name_en: "CAN'T GO WONG",
              name_ch: "獎星",
              status: "Ran",
              barrierDrawNumber: "2",
              handicapWeight: "135",
              finalPosition: 8,
              deadHeat: false,
              winOdds: "4.0",
              jockey: { name_en: "Z Purton" },
              trainer: { name_en: "F C Lor" },
              last6run: "8/3/3/10/5/11",
            },
          ],
        },
      ],
    };
    const m = normalizeMeeting(raw);
    expect(m.races[0].going).toBe("GOOD TO FIRM");
    expect(m.races[0].runners[0].jockey_en).toBe("Z Purton");
    expect(m.races[0].runners[0].win_odds).toBe(4);
    expect(resultsComplete(m.races[0])).toBe(true);
  });

  it("backfill meeting keeps missing fields null", () => {
    const raw: MeetingRaw = {
      date: "2026-10-04",
      venueCode: "ST",
      totalNumberOfRace: 11,
      status: "CLOSED",
      races: [
        {
          no: 1,
          status: "RESULT",
          runners: [
            { no: "1", status: "Ran" },
            { no: "2", status: "Ran" },
          ],
        },
      ],
      pmPools: [
        {
          oddsType: "WIN",
          leg: { number: 1, races: [1] },
          dividends: [{ winComb: "1", div: "118.5" }],
        },
      ],
    };
    const m = normalizeBackfillMeeting(raw);
    expect(m.data_source).toBe("graphql_rbc");
    expect(m.races[0].runners[0].name_en).toBeNull();
    expect(m.races[0].runners[0].final_position).toBeNull();
    expect(m.races[0].runners[0].win_odds).toBeNull();
  });

  it("detects scratched status", () => {
    expect(isScratchedStatus("SCRATCHED")).toBe(true);
    expect(isScratchedStatus("Ran")).toBe(false);
  });
});
