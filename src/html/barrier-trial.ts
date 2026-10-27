/**
 * Parse HKJC barrier trial result pages (btresult / archive).
 * Key: (trial_date, batch_no, horse_code).
 */

import { normalizeHkDate } from "./horse";

export const BARRIER_TRIAL_URL = (trialDateYmd: string, archive = false): string => {
  // Modern path uses DD/MM/YYYY; archive often YYYY/MM/DD.
  if (archive) {
    const ymd = trialDateYmd.replace(/-/g, "/");
    return `https://racing.hkjc.com/en-us/local/information/archive/btresult?Date=${encodeURIComponent(ymd)}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trialDateYmd.trim());
  const dmy = m ? `${m[3]}/${m[2]}/${m[1]}` : trialDateYmd;
  return `https://racing.hkjc.com/en-us/local/information/btresult?Date=${encodeURIComponent(dmy)}`;
};

export interface BarrierTrialHorse {
  horse_code: string | null;
  horse_name: string | null;
  jockey: string | null;
  trainer: string | null;
  draw: number | null;
  gear: string | null;
  lbw: string | null;
  running_position: string | null;
  finish_time: string | null;
  result: string | null;
  comment: string | null;
}

export interface BarrierTrialBatch {
  batch_no: number;
  venue: string | null;
  track: string | null;
  distance: number | null;
  going: string | null;
  batch_time: string | null;
  sectional_times: string | null;
  horses: BarrierTrialHorse[];
}

export interface ParsedBarrierTrialPage {
  trial_date: string | null;
  batches: BarrierTrialBatch[];
  source_url: string;
}

function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numOrNull(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(String(s).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function parseTrialDate(html: string): string | null {
  const m =
    /Trial\s*Date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(html) ||
    /[?&]Date=(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(html) ||
    /[?&]Date=(\d{4}\/\d{1,2}\/\d{1,2})/i.exec(html);
  if (!m) return null;
  const raw = m[1];
  if (/^\d{4}\//.test(raw)) {
    const p = raw.split("/");
    return `${p[0]}-${p[1].padStart(2, "0")}-${p[2].padStart(2, "0")}`;
  }
  return normalizeHkDate(raw);
}

function parseBatchHeader(text: string): {
  batch_no: number | null;
  venue: string | null;
  track: string | null;
  distance: number | null;
} {
  // Batch 3 - CONGHUA ALL WEATHER TRACK - 1200m
  // Batch 1 - SHA TIN TURF - 1000m
  const m =
    /Batch\s*(\d+)\s*[-–]\s*(.+?)\s*[-–]\s*(\d+)\s*m/i.exec(text) ||
    /Batch\s*(\d+)\s*[-–]\s*(.+?)\s+(\d+)\s*m/i.exec(text);
  if (!m) return { batch_no: null, venue: null, track: null, distance: null };

  const loc = m[2].trim();
  let venue: string | null = null;
  let track: string | null = loc;
  if (/CONGHUA/i.test(loc)) {
    venue = "CH";
    track = /ALL\s*WEATHER|AWT/i.test(loc) ? "AWT" : /TURF/i.test(loc) ? "Turf" : loc;
  } else if (/SHA\s*TIN/i.test(loc)) {
    venue = "ST";
    track = /ALL\s*WEATHER|AWT/i.test(loc) ? "AWT" : /TURF/i.test(loc) ? "Turf" : loc;
  } else if (/HAPPY\s*VALLEY/i.test(loc)) {
    venue = "HV";
    track = /TURF/i.test(loc) ? "Turf" : loc;
  }

  return {
    batch_no: Number(m[1]),
    venue,
    track,
    distance: Number(m[3]),
  };
}

function parseHorseCell(cellHtml: string): {
  horse_name: string | null;
  horse_code: string | null;
} {
  const plain = stripHtml(cellHtml);
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

function parseHorseTable(tableHtml: string): BarrierTrialHorse[] {
  const horses: BarrierTrialHorse[] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM: RegExpExecArray | null;
  while ((rowM = rowRe.exec(tableHtml)) !== null) {
    const row = rowM[1];
    if (/subheader|Horse\s*<\/div>/i.test(row) && /Jockey/i.test(row)) continue;
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 8) continue;
    const { horse_name, horse_code } = parseHorseCell(cells[0]);
    if (!horse_code && !horse_name) continue;
    if (/^Horse$/i.test(horse_name ?? "")) continue;
    horses.push({
      horse_name,
      horse_code,
      jockey: stripHtml(cells[1]) || null,
      trainer: stripHtml(cells[2]) || null,
      draw: numOrNull(stripHtml(cells[3])),
      gear: stripHtml(cells[4]) || null,
      lbw: stripHtml(cells[5]) || null,
      running_position: stripHtml(cells[6]).replace(/\s+/g, " ").trim() || null,
      finish_time: stripHtml(cells[7]) || null,
      result: cells[8] != null ? stripHtml(cells[8]) || null : null,
      comment: cells[9] != null ? stripHtml(cells[9]) || null : null,
    });
  }
  return horses;
}

/**
 * Parse a btresult HTML document into batches + horses.
 */
export function parseBarrierTrialPage(
  html: string,
  opts?: { source_url?: string; trial_date?: string | null },
): ParsedBarrierTrialPage {
  const source_url = opts?.source_url ?? "";
  const trial_date = opts?.trial_date ?? parseTrialDate(html);
  const batches: BarrierTrialBatch[] = [];

  // Walk Batch N headers; each is followed by going/time then a bigborder horse table.
  const batchRe =
    /Batch(?:&nbsp;|\s)+(\d+)(?:&nbsp;|\s)*[-–]([\s\S]*?)(?=Batch(?:&nbsp;|\s)+\d+|$)/gi;
  let m: RegExpExecArray | null;
  const sections: Array<{ batch_no: number; chunk: string }> = [];
  while ((m = batchRe.exec(html)) !== null) {
    sections.push({ batch_no: Number(m[1]), chunk: m[0] });
  }

  for (const sec of sections) {
    const headerText = stripHtml(sec.chunk.slice(0, 500));
    const meta = parseBatchHeader(`Batch ${sec.batch_no} - ${headerText}`);
    const goingM = /Going\s*:\s*([A-Z][A-Z\s]*)/i.exec(stripHtml(sec.chunk));
    const timeM = /\bTime\s*:\s*([\d.]+)/i.exec(stripHtml(sec.chunk));
    const sectM = /Sectional\s*Time\s*:\s*([\d.\s]+)/i.exec(stripHtml(sec.chunk));

    const tableM = /<table[^>]*class="[^"]*bigborder[^"]*"[^>]*>([\s\S]*?)<\/table>/i.exec(
      sec.chunk,
    );
    const horses = tableM ? parseHorseTable(tableM[1]) : [];

    batches.push({
      batch_no: sec.batch_no,
      venue: meta.venue,
      track: meta.track,
      distance: meta.distance,
      going: goingM ? goingM[1].trim() : null,
      batch_time: timeM ? timeM[1].trim() : null,
      sectional_times: sectM ? sectM[1].trim().replace(/\s+/g, " ") : null,
      horses,
    });
  }

  return { trial_date, batches, source_url };
}
