/**
 * Parse HKJC gear codes and starter-PDF Gear Change Summary text (issue #50).
 * Markers: 1=first time, 2=replaced, -=removed (no marker = carried).
 */

export const STARTER_PDF_URL = (meetingDateYmd: string): string => {
  const compact = meetingDateYmd.replace(/-/g, "");
  return `https://racing.hkjc.com/racing/content/PDF/RaceCard/${compact}_starter_all.pdf`;
};

export interface GearItem {
  code: string;
  /** "1" | "2" | "-" | null (unchanged / carried). */
  action: "1" | "2" | "-" | null;
}

export interface GearChangeRow {
  race_no: number | null;
  horse_no: number | null;
  is_standby: boolean;
  horse_name: string | null;
  gear_raw: string;
  gear_items: GearItem[];
}

/** Known gear abbreviations (longest first for greedy match). */
const GEAR_CODES = [
  "XB",
  "VO",
  "TT",
  "SR",
  "SB",
  "RU",
  "RT",
  "RO",
  "RB",
  "PS",
  "PC",
  "NB",
  "LB",
  "CP",
  "CO",
  "CC",
  "BR",
  "BO",
  "BL",
  "BB",
  "V",
  "P",
  "H",
  "E",
  "B",
] as const;

const CODE_ALT = GEAR_CODES.join("|");
const ITEM_RE = new RegExp(`(${CODE_ALT})([12\\-])?`, "gi");

export function parseGearItems(raw: string | null | undefined): GearItem[] {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s || s === "-" || s === "—") return [];
  const items: GearItem[] = [];
  ITEM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ITEM_RE.exec(s)) !== null) {
    const action = m[2] as "1" | "2" | "-" | undefined;
    items.push({
      code: m[1].toUpperCase(),
      action: action ?? null,
    });
  }
  return items;
}

/** True when any item has a change marker (1/2/-). */
export function gearHasChangeMarker(raw: string | null | undefined): boolean {
  return parseGearItems(raw).some((g) => g.action != null);
}

/**
 * Parse starter PDF "Gear Change Summary" page text (already extracted).
 * Lines look like: `9 5 SWORD POINT CP-/B1` or continuation `  6 GLITTERING…`.
 */
export function parseGearChangeSummaryText(
  text: string,
  opts?: { meeting_date?: string },
): {
  meeting_date: string | null;
  rows: GearChangeRow[];
} {
  void opts;
  const rows: GearChangeRow[] = [];
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trimEnd());

  let inSummary = false;
  let currentRace: number | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/Gear\s+Change\s+Summary/i.test(trimmed)) {
      inSummary = true;
      continue;
    }
    if (!inSummary) continue;
    if (/^Abbreviations\b/i.test(trimmed)) break;
    if (!trimmed) continue;
    if (/^Race\s+Horse\s+No/i.test(trimmed)) continue;

    // "Standby 2 FRANCIS MEYNELL B1" or "9 5 SWORD POINT CP-/B1"
    const standby = /^(?:(\d+)\s+)?Standby\s+(\d+)\s+(.+?)\s+([A-Z][A-Z0-9/\-]*)$/i.exec(
      trimmed,
    );
    if (standby) {
      if (standby[1]) currentRace = Number(standby[1]);
      const gear_raw = standby[4];
      rows.push({
        race_no: currentRace,
        horse_no: Number(standby[2]),
        is_standby: true,
        horse_name: standby[3].trim(),
        gear_raw,
        gear_items: parseGearItems(gear_raw),
      });
      continue;
    }

    const full =
      /^(\d+)\s+(\d+)\s+(.+?)\s+([A-Z][A-Z0-9/\-]*)$/i.exec(trimmed) ||
      /^\s+(\d+)\s+(.+?)\s+([A-Z][A-Z0-9/\-]*)$/i.exec(trimmed);

    if (!full) continue;

    if (full.length === 5) {
      currentRace = Number(full[1]);
      const gear_raw = full[4];
      rows.push({
        race_no: currentRace,
        horse_no: Number(full[2]),
        is_standby: false,
        horse_name: full[3].trim(),
        gear_raw,
        gear_items: parseGearItems(gear_raw),
      });
    } else {
      const gear_raw = full[3];
      rows.push({
        race_no: currentRace,
        horse_no: Number(full[1]),
        is_standby: false,
        horse_name: full[2].trim(),
        gear_raw,
        gear_items: parseGearItems(gear_raw),
      });
    }
  }

  return { meeting_date: null, rows };
}

/**
 * Best-effort Latin text extraction from a PDF ArrayBuffer for Gear Change Summary.
 * Uses literal PDF string tokens; enough for ASCII gear tables when ToUnicode is absent.
 */
export function extractPdfLatinText(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let raw = "";
  // Prefer uncompressed view; fall back to latin1 decode of whole file.
  try {
    raw = new TextDecoder("latin1").decode(bytes);
  } catch {
    return "";
  }

  const parts: string[] = [];
  // (...) string literals (handle simple escapes)
  const re = /\((?:\\.|[^\\)])*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    let s = m[0].slice(1, -1);
    s = s
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "")
      .replace(/\\t/g, "\t")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\");
    if (/[\x20-\x7E]/.test(s)) parts.push(s);
  }
  // Also keep readable runs outside streams for TOC pages.
  const asciiRuns = raw.match(/[A-Za-z][A-Za-z0-9 .,\-\/"'+]{3,}/g) ?? [];
  return `${parts.join(" ")}\n${asciiRuns.join("\n")}`;
}
