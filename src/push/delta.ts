import type { RaceOddsSnapshot, RunnerOdds } from "../parse/odds";
import type { PmPoolRaw } from "../graphql/types";
import {
  ODDS_BASIS,
  formatHkNow,
  type OddsBetType,
  type OddsDeltaChange,
  type OddsPoolInvestment,
  type PushRace,
} from "./envelope";

export interface HorseNamePair {
  horse_name_en: string | null;
  horse_name_ch: string | null;
}

/**
 * Index runners by stable runner_id. If two rows somehow share an id,
 * Declared wins over Standby (standby never overwrites declared).
 */
export function runnersById(runners: RunnerOdds[]): Map<string, RunnerOdds> {
  const m = new Map<string, RunnerOdds>();
  for (const r of runners) {
    const id = r.runner_id;
    if (!id) continue;
    const prev = m.get(id);
    if (prev) {
      if (prev.status === "Declared" && r.status === "Standby") continue;
      if (prev.status === "Standby" && r.status === "Declared") {
        m.set(id, r);
        continue;
      }
    }
    m.set(id, r);
  }
  return m;
}

function nameFor(
  runner: RunnerOdds | undefined,
  names?: Map<string, HorseNamePair>,
  runnerId?: string,
): HorseNamePair {
  const fromId = runnerId != null ? names?.get(runnerId) : undefined;
  // Cloth fallback for callers that still index Chinese names by horse_no.
  const fromCloth =
    runner && runner.horse_no > 0
      ? names?.get(String(runner.horse_no))
      : undefined;
  const fromMap = fromId ?? fromCloth;
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
    runner_id: string;
    horse_no: number;
    status: string;
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
    runner_no: args.horse_no,
    runner_id: args.runner_id,
    horse_no: args.horse_no,
    horse_name_ch: args.names.horse_name_ch,
    horse_name_en: args.names.horse_name_en,
    horse_name: args.names.horse_name_en,
    status: args.status,
    bet_type: args.bet_type,
    pool: args.bet_type,
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
 * Keys by runner_id (never horse_no alone). prev null ⇒ first observation.
 */
export function computeOddsDeltaChanges(args: {
  prev: RaceOddsSnapshot | null;
  next: RaceOddsSnapshot;
  /** Optional names keyed by runner_id (preferred) or legacy horse_no string. */
  horseNames?: Map<string, HorseNamePair>;
}): OddsDeltaChange[] {
  const { prev, next, horseNames } = args;
  const source_last_updated_at = next.payload.last_update;
  const out: OddsDeltaChange[] = [];
  const prevMap = prev ? runnersById(prev.runners) : new Map<string, RunnerOdds>();
  const nextMap = runnersById(next.runners);
  const ids = new Set([...prevMap.keys(), ...nextMap.keys()]);

  for (const runnerId of [...ids].sort()) {
    const p = prevMap.get(runnerId);
    const n = nextMap.get(runnerId);
    // Standby odds must never appear as overwrites of declared pool odds; both
    // sides are tracked under distinct runner_ids after parse. Skip empty.
    if (!p && !n) continue;
    const names = nameFor(n ?? p, horseNames, runnerId);
    const horse_no = (n ?? p)!.horse_no;
    const status = (n ?? p)!.status;
    const base = {
      race_no: next.race_no,
      runner_id: runnerId,
      horse_no,
      status,
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

/**
 * Normalize an instant to Asia/Hong_Kong wall time with explicit `+08:00`.
 * Already-offset ISO strings are re-projected via Date so receivers always see HK.
 */
export function toHongKongSourceTs(
  iso: string | null | undefined,
  fallbackDate: Date = new Date(),
): string | null {
  if (iso == null || String(iso).trim() === "") return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return formatHkNow(new Date(ms));
}

/** Attach source_ts (+08:00) on each push race from source_last_updated_at. */
export function withRaceSourceTs(races: PushRace[]): PushRace[] {
  return races.map((r) => ({
    ...r,
    source_ts: toHongKongSourceTs(r.source_last_updated_at ?? null) ?? null,
  }));
}

export interface FullSnapshotCoverageMeta {
  covered_races: number[];
  missing_races: number[];
  /** race_no → Asia/Hong_Kong source timestamp (or null). */
  race_source_ts: Record<string, string | null>;
}

/**
 * Coverage report for a full odds_update. `expectedRaceNos` = meeting card;
 * `races` = what we actually emit.
 */
export function buildFullSnapshotCoverageMeta(args: {
  expectedRaceNos: number[];
  races: PushRace[];
}): FullSnapshotCoverageMeta {
  const covered = [...new Set(args.races.map((r) => r.race_no))].sort(
    (a, b) => a - b,
  );
  const coveredSet = new Set(covered);
  const expected = [...new Set(args.expectedRaceNos)].sort((a, b) => a - b);
  const missing = expected.filter((n) => !coveredSet.has(n));
  const race_source_ts: Record<string, string | null> = {};
  for (const r of args.races) {
    race_source_ts[String(r.race_no)] =
      r.source_ts ??
      toHongKongSourceTs(r.source_last_updated_at ?? null) ??
      null;
  }
  for (const n of missing) {
    if (!(String(n) in race_source_ts)) race_source_ts[String(n)] = null;
  }
  return { covered_races: covered, missing_races: missing, race_source_ts };
}
