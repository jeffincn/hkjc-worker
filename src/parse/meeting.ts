import { LOCAL_VENUES } from "../graphql/queries";
import type {
  ActiveMeetingSummary,
  ChangeHistoryRaw,
  MeetingRaw,
  PmPoolRaw,
  RaceRaw,
  RunnerRaw,
} from "../graphql/types";
import { normalizeHorseCode } from "./horse-code";
import { isStandbyRunner, parseOddsValue } from "./odds";

export interface NormalizedMeeting {
  meeting_date: string;
  venue: string;
  total_races: number | null;
  status: string | null;
  races: NormalizedRace[];
  change_histories: ChangeHistoryRaw[];
  data_source: string;
}

export interface NormalizedRace {
  race_no: number;
  post_time: string | null;
  status: string | null;
  distance: number | null;
  going: string | null;
  course_desc: string | null;
  course_code: string | null;
  race_class: string | null;
  /** GraphQL wageringFieldSize — preferred draw_size hint (issue #33). */
  wagering_field_size?: number | null;
  runners: NormalizedRunner[];
}

export interface NormalizedRunner {
  /**
   * Saddle cloth for Declared, or standbyNo for Standby.
   * Not unique alone — pair with `is_standby`.
   */
  horse_no: number;
  /**
   * True for reserve / standby runners (GraphQL status or empty `no`+standbyNo).
   * Part of runners PK so standby never overwrites declared on the same cloth.
   */
  is_standby: boolean;
  /** GraphQL `standbyNo` when present; null for pure declared. */
  standby_no: number | null;
  /** HKJC brand code (e.g. H087) from GraphQL horse.code; null when unknown. */
  horse_code: string | null;
  /** GraphQL horse.id when present (e.g. HK_2022_H087). */
  horse_id: string | null;
  name_en: string | null;
  name_ch: string | null;
  status: string | null;
  barrier: number | null;
  handicap_weight: number | null;
  jockey_en: string | null;
  trainer_en: string | null;
  last6run: string | null;
  final_position: number | null;
  dead_heat: boolean | null;
  win_odds: number | null;
}

export function isLocalVenue(venue: string): boolean {
  return LOCAL_VENUES.has(venue);
}

export function filterLocalMeetings<T extends { venueCode: string }>(items: T[]): T[] {
  return items.filter((m) => isLocalVenue(m.venueCode));
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

export function normalizeRunner(r: RunnerRaw): NormalizedRunner {
  const primary = numOrNull(r.no);
  const standby = numOrNull(r.standbyNo);
  const is_standby = isStandbyRunner(r);
  // Declared: prefer `no`; Standby: prefer `standbyNo` (often empty `no`).
  // Never coerce "" → 0.
  const horse_no = is_standby
    ? standby != null && standby > 0
      ? standby
      : (primary ?? -1)
    : primary != null && primary > 0
      ? primary
      : (standby ?? -1);
  const standby_no = standby != null && standby > 0 ? standby : null;
  const horse_id =
    r.horse?.id != null && String(r.horse.id).trim() !== ""
      ? String(r.horse.id).trim()
      : null;
  return {
    horse_no,
    is_standby,
    standby_no,
    horse_code: normalizeHorseCode(r.horse?.code),
    horse_id,
    name_en: r.name_en ?? null,
    name_ch: r.name_ch ?? null,
    status: r.status ?? (is_standby ? "Standby" : null),
    barrier: numOrNull(r.barrierDrawNumber),
    handicap_weight: numOrNull(r.handicapWeight),
    jockey_en: r.jockey?.name_en ?? null,
    trainer_en: r.trainer?.name_en ?? null,
    last6run: r.last6run ?? null,
    // GraphQL sometimes returns finalPosition=0 when unparsed; 0 is not a
    // valid placing — treat as missing so dividends WIN winComb can fill (R1).
    final_position: (() => {
      const p = r.finalPosition ?? null;
      if (p == null) return null;
      return p > 0 ? p : null;
    })(),
    dead_heat: r.deadHeat ?? null,
    win_odds: parseOddsValue(r.winOdds),
  };
}

export function normalizeRace(race: RaceRaw): NormalizedRace {
  const wfs = race.wageringFieldSize;
  return {
    race_no: race.no,
    post_time: race.postTime ?? null,
    status: race.status ?? null,
    distance: race.distance ?? null,
    going: race.go_en ?? null,
    course_desc: race.raceCourse?.description_en ?? null,
    course_code: race.raceCourse?.displayCode ?? null,
    race_class: race.raceClass_en ?? null,
    wagering_field_size:
      wfs != null && Number.isFinite(wfs) && wfs > 0 ? Number(wfs) : null,
    runners: (race.runners ?? []).map(normalizeRunner),
  };
}

export function normalizeMeeting(
  meeting: MeetingRaw,
  data_source = "graphql",
): NormalizedMeeting {
  return {
    meeting_date: meeting.date,
    venue: meeting.venueCode,
    total_races: meeting.totalNumberOfRace ?? meeting.races?.length ?? null,
    status: meeting.status ?? null,
    races: (meeting.races ?? []).map(normalizeRace),
    change_histories: meeting.changeHistories ?? [],
    data_source,
  };
}

/** Backfill (rbcMeeting): runners only have no/status; names/odds/positions stay null. */
export function normalizeBackfillMeeting(meeting: MeetingRaw): NormalizedMeeting {
  const dividendsByRace = groupDividends(meeting.pmPools ?? []);
  const normalized = normalizeMeeting(meeting, "graphql_rbc");
  for (const race of normalized.races) {
    for (const runner of race.runners) {
      // rbcMeeting does not provide these
      runner.name_en = runner.name_en ?? null;
      runner.name_ch = runner.name_ch ?? null;
      runner.barrier = null;
      runner.handicap_weight = null;
      runner.jockey_en = null;
      runner.trainer_en = null;
      runner.last6run = null;
      runner.final_position = null;
      runner.dead_heat = null;
      runner.win_odds = null;
    }
    (race as NormalizedRace & { dividends?: unknown }).dividends =
      dividendsByRace.get(race.race_no) ?? null;
  }
  return normalized;
}

export function groupDividends(pools: PmPoolRaw[]): Map<number, PmPoolRaw[]> {
  const map = new Map<number, PmPoolRaw[]>();
  for (const pool of pools) {
    const raceNo = pool.leg?.number ?? pool.leg?.races?.[0];
    if (raceNo == null) continue;
    const list = map.get(raceNo) ?? [];
    list.push(pool);
    map.set(raceNo, list);
  }
  return map;
}

export function pickHkActiveMeetings(
  active: ActiveMeetingSummary[] | undefined,
): ActiveMeetingSummary[] {
  return filterLocalMeetings(active ?? []);
}

export function resultsComplete(race: NormalizedRace): boolean {
  const runners = race.runners.filter((r) => {
    const s = (r.status ?? "").toUpperCase();
    return s !== "SCRATCHED" && s !== "STANDBY" && !s.includes("SCRATCH");
  });
  if (runners.length === 0) return false;
  return runners.every((r) => r.final_position != null && r.final_position > 0);
}

export function isScratchedStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toUpperCase();
  return s.includes("SCRATCH") || s === "SCRATCHED" || s === "WITHDRAWN";
}
