/**
 * Parse HKJC displaysectionaltime HTML (en-us local information page).
 * Legacy DisplaySectionalTime.aspx redirects / is retired; use the path below.
 */

import { contentHash } from "../parse/hash";

/** One page = one race. Older dates may 302 → /archive/displaysectionaltime. */
export const SECTIONAL_PAGE_URL = (meetingDateYmd: string, raceNo: number): string => {
  const racedate = ymdToHkjcDate(meetingDateYmd);
  return `https://racing.hkjc.com/en-us/local/information/displaysectionaltime?racedate=${encodeURIComponent(racedate)}&RaceNo=${raceNo}`;
};

export interface SectionalCell {
  pos: number | null;
  margin: string | null;
  time: number | null;
  /** 200m splits when present on later sections (usually last two). */
  splits: number[] | null;
}

export interface SectionalSegment extends SectionalCell {
  idx: number;
}

export interface SectionalHorseRow {
  finishing_order: number | null;
  horse_no: number | null;
  horse_name: string | null;
  horse_code: string | null;
  finish_time: string | null;
  finish_time_sec: number | null;
  /** sec1..sec6 (null when blank column). */
  sections: Array<SectionalCell | null>;
  segments: SectionalSegment[];
}

export interface ParsedSectionalPage {
  meeting_date: string | null;
  venue: string | null;
  race_no: number | null;
  race_info: string | null;
  race_name: string | null;
  horses: SectionalHorseRow[];
  source_url: string;
}

function ymdToHkjcDate(ymd: string): string {
  // YYYY-MM-DD → DD/MM/YYYY
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return ymd;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function hkjcDateToYmd(dmy: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dmy.trim());
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseFinishTimeSec(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  // 1:08.41 or 0:58.12 or 58.12
  const m = /^(?:(\d+):)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const mins = m[1] ? Number(m[1]) : 0;
  const secs = Number(m[2]);
  const frac = m[3] ? Number(`0.${m[3]}`) : 0;
  if (![mins, secs, frac].every((n) => Number.isFinite(n))) return null;
  return mins * 60 + secs + frac;
}

function parseVenueCode(html: string): string | null {
  if (/Happy\s*Valley/i.test(html)) return "HV";
  if (/Sha\s*Tin/i.test(html)) return "ST";
  // option values sometimes ST / HV
  const opt = /<option[^>]*value="(ST|HV)"[^>]*selected/i.exec(html);
  if (opt) return opt[1].toUpperCase();
  return null;
}

function parseRaceNoFromHtml(html: string): number | null {
  const id = /<div\s+id="Race(\d+)"/i.exec(html);
  if (id) return Number(id[1]);
  const label = /Race\s*(\d+)/i.exec(stripHtml(html).slice(0, 2000));
  return label ? Number(label[1]) : null;
}

function parseRaceInfo(html: string): { race_info: string | null; race_name: string | null } {
  // First span under Race block: "Class 4 ... Good To Firm"
  const block = /<div\s+id="Race\d+"[\s\S]*?<div class="Race[^"]*"[\s\S]*?<p class="f_fl[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(
    html,
  );
  if (!block) return { race_info: null, race_name: null };
  const spans = [...block[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map((m) =>
    decodeEntities(stripHtml(m[1])),
  );
  const nonempty = spans.filter(Boolean);
  return {
    race_info: nonempty[0] ?? null,
    race_name: nonempty[1] ?? null,
  };
}

function parseMeetingDateFromHtml(html: string): string | null {
  const m =
    /racedate=(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(html) ||
    /RaceDate=(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(html);
  return m ? hkjcDateToYmd(m[1]) : null;
}

function splitTopLevelTds(trInner: string): string[] {
  const cells: string[] = [];
  const re = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trInner)) !== null) {
    cells.push(m[1]);
  }
  return cells;
}

function parseSectionCell(cellHtml: string): SectionalCell | null {
  const text = stripHtml(cellHtml);
  if (!text || /blank_img/i.test(cellHtml)) return null;
  if (!/\d/.test(text)) return null;

  const posM = /<span[^>]*class="[^"]*f_fl[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(cellHtml);
  const marginM = /<i>([\s\S]*?)<\/i>/i.exec(cellHtml);
  const pos = posM ? Number(stripHtml(posM[1])) : null;

  // Section time: first plain <p>…</p> or p.sectional_200 leading number
  let time: number | null = null;
  const p200 = /<p[^>]*class="[^"]*sectional_200[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(cellHtml);
  const pPlain = /<p(?![^>]*f_clear)[^>]*>([\s\S]*?)<\/p>/i.exec(cellHtml);
  const timeSrc = p200?.[1] ?? pPlain?.[1] ?? "";
  const timeM = /(\d+(?:\.\d+)?)/.exec(stripHtml(timeSrc.split("<")[0] ?? timeSrc));
  if (timeM) time = Number(timeM[1]);

  let splits: number[] | null = null;
  // color_blue2 wraps nested <span>NN.NN</span> pairs; non-greedy </span> would stop early.
  const blueAt = cellHtml.search(/class=["'][^"']*color_blue2/i);
  if (blueAt >= 0) {
    const slice = cellHtml.slice(blueAt);
    const nums = [...slice.matchAll(/<span[^>]*>\s*(\d+(?:\.\d+)?)\s*</gi)].map((x) =>
      Number(x[1]),
    );
    if (nums.length >= 2) splits = nums.slice(0, 2);
    else if (nums.length === 1) splits = nums;
  }

  return {
    pos: Number.isFinite(pos as number) ? pos : null,
    margin: marginM ? stripHtml(marginM[1]) || null : null,
    time: Number.isFinite(time as number) ? time : null,
    splits,
  };
}

function parseHorseCell(cellHtml: string): {
  horse_name: string | null;
  horse_code: string | null;
} {
  const plain = decodeEntities(stripHtml(cellHtml));
  // NAME (CODE) — brand code in trailing parens
  const m = /^(.*?)\s*\(([A-Z0-9]+)\)\s*$/i.exec(plain);
  if (m) {
    return { horse_name: m[1].trim() || null, horse_code: m[2].toUpperCase() };
  }
  const href = /horseid=HK_\d+_([A-Z0-9]+)/i.exec(cellHtml);
  return {
    horse_name: plain || null,
    horse_code: href ? href[1].toUpperCase() : null,
  };
}

/**
 * Parse a displaysectionaltime HTML document into structured per-horse rows.
 * `venueHint` / `meetingDateHint` / `raceNoHint` fill gaps when the page omits them.
 */
export function parseSectionalPage(
  html: string,
  opts?: {
    source_url?: string;
    venue?: string | null;
    meeting_date?: string | null;
    race_no?: number | null;
  },
): ParsedSectionalPage {
  const source_url = opts?.source_url ?? "";
  const { race_info, race_name } = parseRaceInfo(html);
  const venue = opts?.venue ?? parseVenueCode(html);
  const meeting_date = opts?.meeting_date ?? parseMeetingDateFromHtml(html);
  const race_no = opts?.race_no ?? parseRaceNoFromHtml(html);

  const tableM = /<table[^>]*class="[^"]*race_table[^"]*"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  const horses: SectionalHorseRow[] = [];
  if (!tableM) {
    return {
      meeting_date,
      venue,
      race_no,
      race_info,
      race_name,
      horses,
      source_url,
    };
  }

  const tbodyM = /<tbody>([\s\S]*?)<\/tbody>/i.exec(tableM[1]);
  const body = tbodyM?.[1] ?? tableM[1];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM: RegExpExecArray | null;
  while ((rowM = rowRe.exec(body)) !== null) {
    const cells = splitTopLevelTds(rowM[1]);
    // Finishing Order | Horse No. | Horse | 6 section cols | Time
    if (cells.length < 10) continue;
    const finishing_order = Number(stripHtml(cells[0])) || null;
    const horse_no = Number(stripHtml(cells[1])) || null;
    const { horse_name, horse_code } = parseHorseCell(cells[2]);
    const sectionCells = cells.slice(3, 9);
    const sections: Array<SectionalCell | null> = sectionCells.map(parseSectionCell);
    const segments: SectionalSegment[] = [];
    sections.forEach((sec, i) => {
      if (!sec) return;
      segments.push({ idx: i + 1, ...sec });
    });
    const finish_time = stripHtml(cells[9]) || null;
    horses.push({
      finishing_order,
      horse_no,
      horse_name,
      horse_code,
      finish_time,
      finish_time_sec: parseFinishTimeSec(finish_time),
      sections,
      segments,
    });
  }

  return {
    meeting_date,
    venue,
    race_no,
    race_info,
    race_name,
    horses,
    source_url,
  };
}

/** Stable hash payload for change detection (excludes scraped_at / source_url). */
export function sectionalRowsHashPayload(
  meeting_date: string,
  venue: string,
  race_no: number,
  horses: SectionalHorseRow[],
  race_info: string | null,
): unknown {
  return {
    meeting_date,
    venue,
    race_no,
    race_info,
    horses: horses.map((h) => ({
      horse_code: h.horse_code,
      horse_no: h.horse_no,
      finishing_order: h.finishing_order,
      finish_time: h.finish_time,
      segments: h.segments,
    })),
  };
}

export async function hashSectionalRace(
  meeting_date: string,
  venue: string,
  race_no: number,
  horses: SectionalHorseRow[],
  race_info: string | null,
): Promise<string> {
  return contentHash(
    sectionalRowsHashPayload(meeting_date, venue, race_no, horses, race_info),
  );
}

export function cellToJson(cell: SectionalCell | null): string | null {
  if (!cell) return null;
  return JSON.stringify({
    pos: cell.pos,
    margin: cell.margin,
    time: cell.time,
  });
}

export function segmentsToJson(segments: SectionalSegment[]): string {
  return JSON.stringify(
    segments.map((s) => ({
      idx: s.idx,
      pos: s.pos,
      margin: s.margin,
      time: s.time,
      splits: s.splits,
    })),
  );
}
