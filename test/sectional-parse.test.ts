import { describe, expect, it } from "vitest";
import {
  hkjcDateToYmd,
  parseFinishTimeSec,
  parseSectionalPage,
  SECTIONAL_PAGE_URL,
} from "../src/html/sectional";
import { isLivePushEvent } from "../src/push/envelope";
import {
  sectional_mini_1800,
  sectional_mini_2015,
  sectional_mini_2026,
} from "./fixtures/sectional-html";

describe("sectional HTML parsers", () => {
  it("builds modern displaysectionaltime URL (not legacy aspx)", () => {
    expect(SECTIONAL_PAGE_URL("2026-10-25", 1)).toBe(
      "https://racing.hkjc.com/en-us/local/information/displaysectionaltime?racedate=25%2F10%2F2026&RaceNo=1",
    );
    expect(hkjcDateToYmd("25/10/2026")).toBe("2026-10-25");
    expect(parseFinishTimeSec("1:08.41")).toBeCloseTo(68.41, 5);
    expect(parseFinishTimeSec("58.12")).toBeCloseTo(58.12, 5);
  });

  it("parses per-horse sections + 200m splits (ST 1200m)", () => {
    const page = parseSectionalPage(sectional_mini_2026, {
      meeting_date: "2026-10-25",
      venue: "ST",
      race_no: 1,
      source_url: SECTIONAL_PAGE_URL("2026-10-25", 1),
    });
    expect(page.venue).toBe("ST");
    expect(page.race_no).toBe(1);
    expect(page.race_info).toMatch(/Class 4/);
    expect(page.horses.length).toBeGreaterThanOrEqual(2);

    const winner = page.horses[0];
    expect(winner.horse_code).toBe("M046");
    expect(winner.horse_name).toMatch(/HAPPY PEGASUS/i);
    expect(winner.horse_no).toBe(6);
    expect(winner.finishing_order).toBe(1);
    expect(winner.finish_time).toBe("1:08.41");
    expect(winner.finish_time_sec).toBeCloseTo(68.41, 5);
    expect(winner.segments.length).toBe(3);
    expect(winner.segments[0]).toMatchObject({
      idx: 1,
      pos: 4,
      margin: "5",
      time: 23.57,
      splits: null,
    });
    expect(winner.segments[1].splits).toEqual([10.93, 11.22]);
    expect(winner.segments[2].splits).toEqual([11.14, 11.55]);
    expect(winner.sections[3]).toBeNull();
  });

  it("parses older pages without 200m splits", () => {
    const page = parseSectionalPage(sectional_mini_2015, {
      meeting_date: "2015-01-01",
      venue: "ST",
      race_no: 1,
    });
    expect(page.horses.length).toBeGreaterThanOrEqual(1);
    const h = page.horses[0];
    expect(h.horse_code).toBe("P405");
    expect(h.segments.length).toBeGreaterThanOrEqual(4);
    expect(h.segments.every((s) => s.splits == null)).toBe(true);
    expect(h.segments[0].time).toBe(14.91);
  });

  it("parses 1800m page with more sections + 200m splits", () => {
    const page = parseSectionalPage(sectional_mini_1800, {
      meeting_date: "2026-10-19",
      venue: "ST",
      race_no: 1,
    });
    expect(page.horses.length).toBeGreaterThanOrEqual(3);
    const winner = page.horses.find((h) => h.finishing_order === 1);
    expect(winner?.horse_code).toBeTruthy();
    expect(winner!.segments.length).toBeGreaterThanOrEqual(5);
    const withSplits = winner!.segments.filter((s) => s.splits && s.splits.length >= 2);
    expect(withSplits.length).toBeGreaterThanOrEqual(1);
  });

  it("gates sectionals push behind LIVE_PUSH_ENABLED", () => {
    expect(isLivePushEvent("sectionals")).toBe(true);
  });
});
