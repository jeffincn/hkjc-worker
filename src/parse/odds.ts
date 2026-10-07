import type { OddsNode, PmPoolRaw, RaceRaw, RunnerRaw } from "../graphql/types";

export interface RunnerOdds {
  horse_no: number;
  horse_name: string | null;
  win_odds: number | null;
  place_odds: number | null;
  status: string | null;
  final_position: number | null;
}

export interface RaceOddsSnapshot {
  race_no: number;
  post_time: string | null;
  snapshot_time: string;
  pool_status: string | null;
  runners: RunnerOdds[];
  /** Canonical payload used for hashing / storage */
  payload: {
    race_no: number;
    pool_status: string | null;
    win: Record<string, number | null>;
    pla: Record<string, number | null>;
    last_update: string | null;
  };
}

export function parseOddsValue(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

export function horseNoFromComb(comb: string): number | null {
  const n = Number(String(comb).trim());
  return Number.isFinite(n) ? n : null;
}

export function poolsByRace(pools: PmPoolRaw[]): Map<number, { win?: PmPoolRaw; pla?: PmPoolRaw }> {
  const map = new Map<number, { win?: PmPoolRaw; pla?: PmPoolRaw }>();
  for (const pool of pools) {
    const raceNo = pool.leg?.number ?? pool.leg?.races?.[0];
    if (raceNo == null) continue;
    const entry = map.get(raceNo) ?? {};
    if (pool.oddsType === "WIN") entry.win = pool;
    if (pool.oddsType === "PLA") entry.pla = pool;
    map.set(raceNo, entry);
  }
  return map;
}

function nodesToMap(nodes: OddsNode[] | undefined): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const n of nodes ?? []) {
    const no = horseNoFromComb(n.combString);
    if (no == null) continue;
    out[String(no)] = parseOddsValue(n.oddsValue);
  }
  return out;
}

export function buildRaceOddsSnapshot(args: {
  race: RaceRaw;
  winPool?: PmPoolRaw;
  plaPool?: PmPoolRaw;
  snapshotTime?: string;
}): RaceOddsSnapshot {
  const { race, winPool, plaPool } = args;
  const snapshot_time =
    args.snapshotTime ??
    winPool?.lastUpdateTime ??
    plaPool?.lastUpdateTime ??
    new Date().toISOString();

  const pool_status = winPool?.sellStatus ?? plaPool?.sellStatus ?? null;
  const winMap = nodesToMap(winPool?.oddsNodes);
  const plaMap = nodesToMap(plaPool?.oddsNodes);

  const runnersSrc: RunnerRaw[] = race.runners ?? [];
  const runners: RunnerOdds[] = runnersSrc.map((r) => {
    const primary = parseOddsValue(r.no as string | number | null); // reuse number parse
    const fromNo =
      r.no === "" || r.no === null || r.no === undefined
        ? null
        : Number(r.no);
    const fromStandby =
      r.standbyNo === "" || r.standbyNo === null || r.standbyNo === undefined
        ? null
        : Number(r.standbyNo);
    const horse_no =
      fromNo != null && Number.isFinite(fromNo) && fromNo > 0
        ? fromNo
        : fromStandby != null && Number.isFinite(fromStandby)
          ? fromStandby
          : -1;
    void primary;
    return {
      horse_no,
      horse_name: r.name_en ?? null,
      win_odds: horse_no > 0 ? (winMap[String(horse_no)] ?? parseOddsValue(r.winOdds)) : null,
      place_odds: horse_no > 0 ? (plaMap[String(horse_no)] ?? null) : null,
      status: r.status ?? null,
      final_position: r.finalPosition ?? null,
    };
  });

  // If pools have horses not listed in runners (backfill case), still include them
  const seen = new Set(runners.map((r) => r.horse_no));
  for (const key of new Set([...Object.keys(winMap), ...Object.keys(plaMap)])) {
    const horse_no = Number(key);
    if (seen.has(horse_no)) continue;
    runners.push({
      horse_no,
      horse_name: null,
      win_odds: winMap[key] ?? null,
      place_odds: plaMap[key] ?? null,
      status: null,
      final_position: null,
    });
  }
  runners.sort((a, b) => a.horse_no - b.horse_no);

  return {
    race_no: race.no,
    post_time: race.postTime ?? null,
    snapshot_time,
    pool_status,
    runners,
    payload: {
      race_no: race.no,
      pool_status,
      win: winMap,
      pla: plaMap,
      last_update: winPool?.lastUpdateTime ?? plaPool?.lastUpdateTime ?? null,
    },
  };
}
