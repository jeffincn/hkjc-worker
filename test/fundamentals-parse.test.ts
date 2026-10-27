import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseBarrierTrialPage } from "../src/html/barrier-trial";
import {
  gearHasChangeMarker,
  parseGearChangeSummaryText,
  parseGearItems,
} from "../src/html/gear";
import { parseHorseProfile, parsePastRuns } from "../src/html/horse";
import { upsertFundamentalsFromHorseRuns } from "../src/store/fundamentals";
import { BTRESULT_CRAZY_TREASURE_HTML } from "./fixtures/btresult-crazy-treasure";
import { GEAR_CHANGE_SUMMARY_TEXT } from "./fixtures/gear-change-summary";
import { SWORD_POINT_HORSE_HTML } from "./fixtures/sword-point-horse";

describe("fundamentals parsers (issue #50)", () => {
  it("parses gear change markers (1 / 2 / -)", () => {
    expect(parseGearItems("CP-/B1")).toEqual([
      { code: "CP", action: "-" },
      { code: "B", action: "1" },
    ]);
    expect(parseGearItems("B-/CP2")).toEqual([
      { code: "B", action: "-" },
      { code: "CP", action: "2" },
    ]);
    expect(parseGearItems("B/TT")).toEqual([
      { code: "B", action: null },
      { code: "TT", action: null },
    ]);
    expect(gearHasChangeMarker("CP-/B1")).toBe(true);
    expect(gearHasChangeMarker("CP")).toBe(false);
  });

  it("parses starter PDF Gear Change Summary text (SWORD POINT)", () => {
    const { rows } = parseGearChangeSummaryText(GEAR_CHANGE_SUMMARY_TEXT);
    const sword = rows.find((r) => /SWORD POINT/i.test(r.horse_name ?? ""));
    expect(sword).toBeTruthy();
    expect(sword!.race_no).toBe(9);
    expect(sword!.horse_no).toBe(5);
    expect(sword!.gear_raw).toBe("CP-/B1");
  });

  it("parses SWORD POINT horse page acceptance samples", () => {
    const profile = parseHorseProfile(
      SWORD_POINT_HORSE_HTML,
      "G448",
      "https://example/horse",
    );
    expect(profile.last_rating).toBe("73");
    expect(profile.name_en).toMatch(/SWORD POINT/i);

    const runs = parsePastRuns(SWORD_POINT_HORSE_HTML);
    expect(runs.length).toBeGreaterThanOrEqual(2);

    const jun = runs.find((r) => r.race_date === "2026-06-27");
    expect(jun?.gear).toBe("CP-/B1");
    expect(jun?.declared_weight).toBe(1135);
    expect(jun?.rating).toBe("78");
    expect(jun?.venue).toBe("ST");
    expect(jun?.track).toMatch(/AWT/i);
    expect(jun?.race_no).toBe(9);

    const jul = runs.find((r) => r.race_date === "2026-07-08");
    expect(jul?.gear).toBe("B-/CP2");
    expect(jul?.declared_weight).toBe(1140);
    expect(jul?.venue).toBe("HV");
    expect(jul?.course).toBe("B");

    const may = runs.find((r) => r.race_date === "2026-05-24");
    expect(may?.declared_weight).toBe(1144);
  });

  it("parses CRAZY TREASURE barrier trial (1.10.60 / 4 4 1)", () => {
    const page = parseBarrierTrialPage(BTRESULT_CRAZY_TREASURE_HTML, {
      trial_date: "2024-08-22",
      source_url: "https://example/btresult",
    });
    expect(page.trial_date).toBe("2024-08-22");
    expect(page.batches.length).toBeGreaterThanOrEqual(1);
    const batch3 = page.batches.find((b) => b.batch_no === 3);
    expect(batch3).toBeTruthy();
    expect(batch3!.distance).toBe(1200);
    expect(batch3!.venue).toBe("CH");
    expect(batch3!.batch_time).toBe("1.10.60");
    expect(batch3!.sectional_times).toMatch(/24\.8/);

    const crazy = batch3!.horses.find((h) => h.horse_code === "J063");
    expect(crazy).toBeTruthy();
    expect(crazy!.horse_name).toMatch(/CRAZY TREASURE/i);
    expect(crazy!.finish_time).toBe("1.10.60");
    expect(crazy!.running_position?.replace(/\s+/g, " ").trim()).toBe("4 4 1");
  });

  it("upserts horse fundamentals into dedicated tables", async () => {
    const profile = parseHorseProfile(
      SWORD_POINT_HORSE_HTML,
      "G448",
      "https://example/horse",
    );
    const runs = parsePastRuns(SWORD_POINT_HORSE_HTML);
    const counts = await upsertFundamentalsFromHorseRuns(env.DB, {
      horse_code: "G448",
      profile,
      runs,
      source_url: "https://example/horse",
    });
    expect(counts.gear).toBeGreaterThanOrEqual(2);
    expect(counts.ratings).toBeGreaterThanOrEqual(2);
    expect(counts.weights).toBeGreaterThanOrEqual(3);

    const gear = await env.DB.prepare(
      `SELECT gear_raw FROM gear_changes WHERE horse_code=? AND race_date=?`,
    )
      .bind("G448", "2026-06-27")
      .first<{ gear_raw: string }>();
    expect(gear?.gear_raw).toBe("CP-/B1");

    const wt = await env.DB.prepare(
      `SELECT declared_weight FROM declared_horse_weights
       WHERE horse_code=? AND race_date=?`,
    )
      .bind("G448", "2026-07-08")
      .first<{ declared_weight: number }>();
    expect(wt?.declared_weight).toBe(1140);

    const rail = await env.DB.prepare(
      `SELECT course_code FROM rail_positions
       WHERE meeting_date=? AND venue=?`,
    )
      .bind("2026-07-08", "HV")
      .first<{ course_code: string }>();
    expect(rail?.course_code).toBe("B");
  });
});
