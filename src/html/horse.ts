/**
 * Parse racing.hkjc.com horse profile + past-performance HTML.
 * GraphQL whitelist does not expose these fields.
 */

import { contentHash } from "../parse/hash";

export const HORSE_PAGE_URL = (code: string, option = "1") =>
  `https://racing.hkjc.com/en-us/local/information/horse?HorseNo=${encodeURIComponent(code)}&Option=${option}`;

export const VET_PAGE_URL = (meetingDate?: string, venue?: string) => {
  if (meetingDate && venue) {
    const d = meetingDate.replace(/-/g, "/");
    return `https://racing.hkjc.com/en-us/local/information/veterinaryrecord?RaceDate=${d}&Racecourse=${venue}`;
  }
  return "https://racing.hkjc.com/en-us/local/information/veterinaryrecord";
};

export interface HorseProfile {
  horse_code: string;
  horse_id: string | null;
  name_en: string | null;
  name_ch: string | null;
  colour: string | null;
  sex: string | null;
  import_type: string | null;
  owner: string | null;
  sire: string | null;
  dam: string | null;
  dams_sire: string | null;
  total_stakes: string | null;
  season_stakes: string | null;
  current_rating: string | null;
  source_url: string;
}

export interface PastRun {
  race_index: string | null;
  placing: string | null;
  race_date: string | null;
  venue: string | null;
  track: string | null;
  course: string | null;
  distance: number | null;
  going: string | null;
  race_class: string | null;
  draw: number | null;
  rating: string | null;
  trainer: string | null;
  jockey: string | null;
  lbw: string | null;
  win_odds: number | null;
  actual_weight: number | null;
  running_position: string | null;
  finish_time: string | null;
  declared_weight: number | null;
  gear: string | null;
}

export interface VetRecord {
  horse_no: string | null;
  horse_name: string | null;
  record_date: string | null;
  details: string | null;
  passed_on: string | null;
}

function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * HKJC horse pages use: <td>Label</td><td>:</td><td>Value</td>
 */
function fieldAfter(html: string, label: string): string | null {
  const re = new RegExp(
    `>(${label})\\s*</t[dh]>\\s*<t[dh][^>]*>\\s*:\\s*</t[dh]>\\s*<t[dh][^>]*>([\\s\\S]*?)</t[dh]>`,
    "i",
  );
  const m = re.exec(html);
  if (m) {
    const v = stripHtml(m[2]);
    return v && v !== ":" ? v : null;
  }
  return null;
}

function numOrNull(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(String(s).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/** Convert dd/mm/yy or dd/mm/yyyy to YYYY-MM-DD when possible. */
export function normalizeHkDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw.trim());
  if (!m) return raw;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

export function parseHorseProfile(html: string, horseCode: string, sourceUrl: string): HorseProfile {
  const title = /<title[^>]*>(.*?)<\/title>/i.exec(html)?.[1] ?? "";
  const nameFromTitle = stripHtml(title).split(" - ")[0] || null;
  const colourSex =
    fieldAfter(html, "Colour\\s*/\\s*Sex") ?? fieldAfter(html, "Colour / Sex");
  let colour: string | null = null;
  let sex: string | null = null;
  if (colourSex) {
    const parts = colourSex.split("/").map((p) => p.trim());
    colour = parts[0] || null;
    sex = parts[1] || null;
  }
  const horseIdMatch =
    /HorseId=([A-Z0-9_]+)/i.exec(html) ??
    /horseid=([A-Z0-9_]+)/i.exec(html) ??
    /(HK_\d{4}_[A-Z0-9]+)/.exec(html);

  return {
    horse_code: horseCode,
    horse_id: horseIdMatch ? horseIdMatch[1] ?? horseIdMatch[0] : null,
    name_en: nameFromTitle,
    name_ch: null,
    colour,
    sex,
    import_type: fieldAfter(html, "Import Type"),
    owner: fieldAfter(html, "Owner"),
    sire: fieldAfter(html, "Sire"),
    dam: fieldAfter(html, "Dam"),
    dams_sire: fieldAfter(html, "Dam'?s Sire"),
    total_stakes: fieldAfter(html, "Total Stakes\\*?"),
    season_stakes: fieldAfter(html, "Season Stakes\\*?"),
    current_rating: fieldAfter(html, "Current Rating"),
    source_url: sourceUrl,
  };
}

/** Remove innermost <table> nodes that are not the past-performance grid (video embeds etc.). */
function stripNonPerformanceTables(html: string): string {
  let s = html;
  for (let i = 0; i < 30; i++) {
    const next = s.replace(/<table\b[^>]*>(?:(?!<table\b)[\s\S])*?<\/table>/gi, (m) =>
      /hsubheader/i.test(m) && /Finish Time/i.test(m) ? m : "",
    );
    if (next === s) break;
    s = next;
  }
  return s;
}

export function parsePastRuns(html: string): PastRun[] {
  const runs: PastRun[] = [];
  const flat = stripNonPerformanceTables(html);
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(flat))) {
    const row = m[1];
    // Skip header / season-banner rows only (not trainer links with ?season=)
    if (/class="[^"]*hsubheader|htable_bold_text/i.test(row)) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripHtml(c[1]));
    if (cells.length < 16) continue;
    if (!/^\d{2,4}$/.test(cells[0] ?? "")) continue;
    const rcParts = (cells[3] ?? "").split("/").map((s) => s.trim());
    runs.push({
      race_index: cells[0] || null,
      placing: cells[1] || null,
      race_date: normalizeHkDate(cells[2] || null),
      venue: rcParts[0] || null,
      track: rcParts[1] || null,
      course: rcParts[2]?.replace(/^"|"$/g, "") || null,
      distance: numOrNull(cells[4]),
      going: cells[5] || null,
      race_class: cells[6] || null,
      draw: numOrNull(cells[7]),
      rating: cells[8] || null,
      trainer: cells[9] || null,
      jockey: cells[10] || null,
      lbw: cells[11] || null,
      win_odds: numOrNull(cells[12]),
      actual_weight: numOrNull(cells[13]),
      running_position: cells[14] || null,
      finish_time: cells[15] || null,
      declared_weight: numOrNull(cells[16]),
      gear: cells[17] || null,
    });
  }
  return runs;
}

export function parseVetRecords(html: string): VetRecord[] {
  const out: VetRecord[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
      stripHtml(c[1]),
    );
    if (cells.length < 4) continue;
    if (/Horse No|Horse Name|Header/i.test(cells[0] ?? "")) continue;
    if (!cells[0] || !/^\d{1,2}$/.test(cells[0])) continue;
    out.push({
      horse_no: cells[0],
      horse_name: cells[1] || null,
      record_date: normalizeHkDate(cells[2] || null),
      details: cells[3] || null,
      passed_on: normalizeHkDate(cells[4] || null),
    });
  }
  return out;
}

export async function hashPayload(value: unknown): Promise<string> {
  return contentHash(value);
}
