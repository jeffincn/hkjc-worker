import type { RaceOddsSnapshot, RunnerOdds } from "../parse/odds";
import type { PmPoolRaw } from "../graphql/types";
import {
  ODDS_BASIS,
  type OddsBetType,
  type OddsDeltaChange,
  type OddsPoolInvestment,
} from "./envelope";

export interface HorseNamePair {
  horse_name_en: string | null;
  horse_name_ch: string | null;
}

function oddsMap(runners: RunnerOdds[]): Map<number, RunnerOdds> {
  const m = new Map<number, RunnerOdds>();
  for (const r of runners) {
    if (r.horse_no > 0) m.set(r.horse_no, r);
  }
  return m;
}

function nameFor(
  runner: RunnerOdds | undefined,
  names?: Map<number, HorseNamePair>,
  horseNo?: number,
): HorseNamePair {
  const fromMap = horseNo != null ? names?.get(horseNo) : undefined;
  return {
    horse_name_en:
      fromMap?.horse_name_en ?? runner?.horse_name ?? null,
    horse_name_ch: fromMap?.horse_name_ch ?? null,
  };
}

function pushChange(
  out: OddsDeltaChange[],
  args: {
    race_no: number;
    runner_no: number;
    names: HorseNamePair;
    bet_type: OddsBetType;
    prev: number | null;
    next: number | null;
    source_last_updated_at: string | null;
    race_post_time: string | null;
    pool_status: string | null;
  },
): void {
  if (args.prev === args.next) return;
  out.push({
    race_no: args.race_no,
    runner_no: args.runner_no,
    horse_name_ch: args.names.horse_name_ch,
    horse_name_en: args.names.horse_name_en,
    bet_type: args.bet_type,
    odds_basis: ODDS_BASIS,
    prev_odds: args.prev,
    new_odds: args.next,
    source_last_updated_at: args.source_last_updated_at,
    race_post_time: args.race_post_time,
    pool_status: args.pool_status,
  });
}

/**
 * Diff prev→next snapshot into per-runner WIN/PLA change rows.
 * prev null ⇒ first observation (prev_odds null for every emitted row).
 */
export function computeOddsDeltaChanges(args: {
  prev: RaceOddsSnapshot | null;
  next: RaceOddsSnapshot;
  horseNames?: Map<number, HorseNamePair>;
}): OddsDeltaChange[] {
  const { prev, next, horseNames } = args;
  const source_last_updated_at = next.payload.last_update;
  const out: OddsDeltaChange[] = [];
  const prevMap = prev ? oddsMap(prev.runners) : new Map<number, RunnerOdds>();
  const nextMap = oddsMap(next.runners);
  const horseNos = new Set([...prevMap.keys(), ...nextMap.keys()]);

  for (const horseNo of [...horseNos].sort((a, b) => a - b)) {
    const p = prevMap.get(horseNo);
    const n = nextMap.get(horseNo);
    const names = nameFor(n ?? p, horseNames, horseNo);
    const base = {
      race_no: next.race_no,
      runner_no: horseNo,
      names,
      source_last_updated_at,
      race_post_time: next.post_time,
      pool_status: next.pool_status,
    };
    pushChange(out, {
      ...base,
      bet_type: "WIN",
      prev: prev ? (p?.win_odds ?? null) : null,
      next: n?.win_odds ?? null,
    });
    pushChange(out, {
      ...base,
      bet_type: "PLA",
      prev: prev ? (p?.place_odds ?? null) : null,
      next: n?.place_odds ?? null,
    });
  }
  return out;
}

function parseInvestment(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Build pools[] from raceMeetings poolInvs (has investment).
 * QUERY_PM_POOLS_ODDS does not expose investment — callers pass poolInvs
 * from the full meeting query when available; otherwise investment is null.
 */
export function buildPoolInvestments(
  pools: PmPoolRaw[] | undefined,
  raceNos: number[],
): OddsPoolInvestment[] {
  const want = new Set(raceNos);
  const out: OddsPoolInvestment[] = [];
  const seen = new Set<string>();

  for (const pool of pools ?? []) {
    const raceNo = pool.leg?.number ?? pool.leg?.races?.[0];
    if (raceNo == null || !want.has(raceNo)) continue;
    const bet =
      pool.oddsType === "WIN" ? "WIN" : pool.oddsType === "PLA" ? "PLA" : null;
    if (!bet) continue;
    const key = `${raceNo}:${bet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      race_no: raceNo,
      bet_type: bet,
      investment: parseInvestment(
        (pool as PmPoolRaw & { investment?: unknown }).investment,
      ),
    });
  }

  // Ensure every requested race has WIN+PLA entries (null investment if missing)
  for (const raceNo of raceNos) {
    for (const bet of ["WIN", "PLA"] as const) {
      const key = `${raceNo}:${bet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ race_no: raceNo, bet_type: bet, investment: null });
    }
  }

  out.sort(
    (a, b) =>
      a.race_no - b.race_no || a.bet_type.localeCompare(b.bet_type),
  );
  return out;
}

/** Max of non-null lastUpdate times; null if all missing. */
export function maxSourceTime(
  times: Array<string | null | undefined>,
): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const t of times) {
    if (t == null || String(t).trim() === "") continue;
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) continue;
    if (ms >= bestMs) {
      bestMs = ms;
      best = t;
    }
  }
  return best;
}
