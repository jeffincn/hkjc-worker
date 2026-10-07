import { describe, expect, it } from "vitest";
import {
  normalizeHkDate,
  parseHorseProfile,
  parsePastRuns,
  parseVetRecords,
} from "../src/html/horse";
import { isLivePushEvent } from "../src/push/envelope";

const SAMPLE_HORSE_HTML = `
<html><title>CAN'T GO WONG - Horses</title>
<table>
<tr><td>Colour / Sex</td><td>:</td><td>Chestnut / Gelding</td></tr>
<tr><td>Import Type</td><td>:</td><td>PP</td></tr>
<tr><td>Owner</td><td>:</td><td>Or Wing Chi</td></tr>
<tr><td>Sire</td><td>:</td><td>Some Sire</td></tr>
<tr><td>Dam</td><td>:</td><td>O'Really Baheeya</td></tr>
<tr><td>Dam's Sire</td><td>:</td><td>O'Reilly</td></tr>
<tr><td>Total Stakes*</td><td>:</td><td>$4,614,250</td></tr>
</table>
<a href="/en-us/local/information/horse?horseid=HK_2022_H087&Option=1">all</a>
<table class=bigborder>
<tr>
  <td class="hsubheader">Race<br />Index</td>
  <td class="hsubheader">Pla.</td>
  <td class="hsubheader">Date</td>
  <td class="hsubheader">RC/Track/<br />Course</td>
  <td class="hsubheader">Dist.</td>
  <td class="hsubheader">G</td>
  <td class="hsubheader">Race<br />Class</td>
  <td class="hsubheader">Dr.</td>
  <td class="hsubheader">Rtg.</td>
  <td class="hsubheader">Trainer</td>
  <td class="hsubheader">Jockey</td>
  <td class="hsubheader">LBW</td>
  <td class="hsubheader">Win Odds</td>
  <td class="hsubheader">Act.<br />Wt.</td>
  <td class="hsubheader">Running<br />Position</td>
  <td class="hsubheader">Finish Time</td>
  <td class="hsubheader">Declar.<br />Horse Wt.</td>
  <td class="hsubheader">Gear</td>
  <td class="hsubheader">Video</td>
</tr>
<tr bgcolor="#F3F1E6">
  <td class="htable_eng_text">079</td>
  <td class="htable_eng_text">08</td>
  <td class="htable_eng_text">07/10/26</td>
  <td class="htable_eng_text">HV / Turf / "C+3"</td>
  <td class="htable_eng_text">1800</td>
  <td class="htable_eng_text">GF</td>
  <td class="htable_eng_text">5</td>
  <td class="htable_eng_text">2</td>
  <td class="htable_eng_text">40</td>
  <td class="htable_eng_text">F C Lor</td>
  <td class="htable_eng_text">Z Purton</td>
  <td class="htable_eng_text">4-3/4</td>
  <td class="htable_eng_text">4</td>
  <td class="htable_eng_text">135</td>
  <td class="htable_eng_text">9 8 8 10 8</td>
  <td class="htable_eng_text">1.50.42</td>
  <td class="htable_eng_text">1170</td>
  <td class="htable_eng_text">B/TT</td>
  <td class="htable_eng_text"><table><tr><td>vid</td></tr></table></td>
</tr>
</table>
`;

const SAMPLE_VET_HTML = `
<table>
<tr><th>Horse No.</th><th>Horse Name</th><th>Date</th><th>Details</th><th>Passed On</th></tr>
<tr>
  <td>1</td><td>AURIO</td><td>07/05/2025</td>
  <td>As the start was effected, reared and failed to jump.</td>
  <td>20/05/2025</td>
</tr>
<tr>
  <td>4</td><td>AMAZING KID</td><td>24/06/2026</td>
  <td>Bled from both nostrils after racing.</td>
  <td>28/09/2026</td>
</tr>
</table>
`;

describe("horse HTML parsers", () => {
  it("normalizes HK dates", () => {
    expect(normalizeHkDate("07/10/26")).toBe("2026-10-07");
    expect(normalizeHkDate("07/05/2025")).toBe("2025-05-07");
  });

  it("parses profile + past runs", () => {
    const profile = parseHorseProfile(
      SAMPLE_HORSE_HTML,
      "H087",
      "https://racing.hkjc.com/en-us/local/information/horse?HorseNo=H087",
    );
    expect(profile.name_en).toContain("CAN'T GO WONG");
    expect(profile.colour).toBe("Chestnut");
    expect(profile.sex).toBe("Gelding");
    expect(profile.horse_id).toBe("HK_2022_H087");

    const runs = parsePastRuns(SAMPLE_HORSE_HTML);
    expect(runs).toHaveLength(1);
    expect(runs[0].race_index).toBe("079");
    expect(runs[0].venue).toBe("HV");
    expect(runs[0].distance).toBe(1800);
    expect(runs[0].win_odds).toBe(4);
    expect(runs[0].finish_time).toBe("1.50.42");
    expect(runs[0].race_date).toBe("2026-10-07");
  });

  it("parses veterinary records", () => {
    const recs = parseVetRecords(SAMPLE_VET_HTML);
    expect(recs).toHaveLength(2);
    expect(recs[0].horse_name).toBe("AURIO");
    expect(recs[1].passed_on).toBe("2026-09-28");
  });

  it("gates new horse push events behind LIVE_PUSH_ENABLED", () => {
    expect(isLivePushEvent("horse_update")).toBe(true);
    expect(isLivePushEvent("injury_update")).toBe(true);
    expect(isLivePushEvent("runs_update")).toBe(true);
    expect(isLivePushEvent("dividends")).toBe(true);
    expect(isLivePushEvent("changes")).toBe(true);
  });
});
