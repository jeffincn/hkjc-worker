import type { OddsNode, PmPoolRaw, RaceRaw, RunnerRaw } from "../graphql/types";

/** Binary entry class for odds identity (standby never shares declared cloth odds). */
export type RunnerEntryStatus = "Declared" | "Standby";

export interface RunnerOdds {
  /**
   * Stable identity: HKJC `horse.code`, else `horse.id` / runner `id`,
   * else `no:{cloth}` / `standby:{cloth}` — never horse_no alone across classes.
   */
  runner_id: string;
  /** Saddle cloth / standby number for display; not a unique key. */
  horse_no: number;
  horse_name: string | null;
  win_odds: number | null;
  place_odds: number | null;
  /** Declared | Standby (scratch/ran stay Declared for pool identity). */
  status: RunnerEntryStatus;
  /** Raw HKJC runner status when known. */
  raw_status: string | null;
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

/** Treat null/undefined/blank as missing (HKJC pre-sale pools use ""). */
function nonEmptyTime(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  return t === "" ? null : t;
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Standby runners often have empty `no` + `standbyNo`, or status containing STANDBY.
 * They must never share WIN/PLA pool odds with a declared cloth of the same number.
 */
export function isStandbyRunner(r: RunnerRaw): boolean {
  const st = (r.status ?? "").toUpperCase();
  if (st.includes("STANDBY")) return true;
  const fromNo = numOrNull(r.no);
  const fromStandby = numOrNull(r.standbyNo);
  return (fromNo == null || fromNo <= 0) && fromStandby != null && fromStandby > 0;
}

export function runnerEntryStatus(r: RunnerRaw): RunnerEntryStatus {
  return isStandbyRunner(r) ? "Standby" : "Declared";
}

/**
 * Prefer HKJC horse code (e.g. H123), then horse.id, then runner id.
 * Last-resort keys keep Declared vs Standby from colliding on cloth number.
 */
export function resolveRunnerId(
  r: RunnerRaw,
  horseNo: number,
  entry: RunnerEntryStatus,
): string {
  const code = r.horse?.code != null ? String(r.horse.code).trim() : "";
  if (code) return code;
  const hid = r.horse?.id != null ? String(r.horse.id).trim() : "";
  if (hid) return `hid:${hid}`;
  const rid = r.id != null ? String(r.id).trim() : "";
  if (rid) return `rid:${rid}`;
  if (entry === "Standby") return `standby:${horseNo}`;
  return `no:${horseNo}`;
}

/**
 * Upgrade legacy D1/push runners that lack runner_id / Declared|Standby status
 * so delta diffs never collapse on horse_no alone.
 */
export function normalizeStoredRunner(
  r: Partial<RunnerOdds> & { horse_no: number },
  index = 0,
): RunnerOdds {
  const raw = r.raw_status ?? (typeof r.status === "string" ? r.status : null);
  const status: RunnerEntryStatus =
    r.status === "Standby" ||
    (typeof raw === "string" && raw.toUpperCase().includes("STANDBY"))
      ? "Standby"
      : "Declared";
  const horse_no = r.horse_no > 0 ? r.horse_no : -1;
  const runner_id =
    r.runner_id && String(r.runner_id).trim() !== ""
      ? String(r.runner_id)
      : status === "Standby"
        ? `standby:${horse_no}`
        : `no:${horse_no > 0 ? horse_no : index}`;
  return {
    runner_id,
    horse_no,
    horse_name: r.horse_name ?? null,
    win_odds: r.win_odds ?? null,
    place_odds: r.place_odds ?? null,
    status,
    raw_status: raw,
    final_position: r.final_position ?? null,
  };
}

export function normalizeStoredSnapshot(snap: RaceOddsSnapshot): RaceOddsSnapshot {
  return {
    ...snap,
    runners: (snap.runners ?? []).map((r, i) => normalizeStoredRunner(r, i)),
  };
}

export function buildRaceOddsSnapshot(args: {
  race: RaceRaw;
  winPool?: PmPoolRaw;
  plaPool?: PmPoolRaw;
  snapshotTime?: string;
}): RaceOddsSnapshot {
  const { race, winPool, plaPool } = args;
  const lastUpdate =
    nonEmptyTime(winPool?.lastUpdateTime) ?? nonEmptyTime(plaPool?.lastUpdateTime);
  const snapshot_time =
    nonEmptyTime(args.snapshotTime) ?? lastUpdate ?? new Date().toISOString();

  const pool_status = winPool?.sellStatus ?? plaPool?.sellStatus ?? null;
  const winMap = nodesToMap(winPool?.oddsNodes);
  const plaMap = nodesToMap(plaPool?.oddsNodes);

  const runnersSrc: RunnerRaw[] = race.runners ?? [];
  const runners: RunnerOdds[] = runnersSrc.map((r) => {
    const entry = runnerEntryStatus(r);
    const fromNo = numOrNull(r.no);
    const fromStandby = numOrNull(r.standbyNo);
    const horse_no =
      entry === "Standby"
        ? (fromStandby != null && fromStandby > 0 ? fromStandby : fromNo ?? -1)
        : fromNo != null && fromNo > 0
          ? fromNo
          : fromStandby != null && fromStandby > 0
            ? fromStandby
            : -1;
    const runner_id = resolveRunnerId(r, horse_no, entry);
    // Pool combString maps to declared cloth numbers only — never apply to Standby.
    const win_odds =
      entry === "Declared" && horse_no > 0
        ? (winMap[String(horse_no)] ?? parseOddsValue(r.winOdds))
        : null;
    const place_odds =
      entry === "Declared" && horse_no > 0 ? (plaMap[String(horse_no)] ?? null) : null;
    return {
      runner_id,
      horse_no,
      horse_name: r.name_en ?? null,
      win_odds,
      place_odds,
      status: entry,
      raw_status: r.status ?? null,
      final_position: r.finalPosition ?? null,
    };
  });

  // Pool cloths not listed on runners (backfill) — treat as Declared only.
  const seenIds = new Set(runners.map((r) => r.runner_id));
  const seenDeclaredCloth = new Set(
    runners.filter((r) => r.status === "Declared" && r.horse_no > 0).map((r) => r.horse_no),
  );
  for (const key of new Set([...Object.keys(winMap), ...Object.keys(plaMap)])) {
    const horse_no = Number(key);
    if (!Number.isFinite(horse_no) || horse_no <= 0) continue;
    if (seenDeclaredCloth.has(horse_no)) continue;
    const runner_id = `no:${horse_no}`;
    if (seenIds.has(runner_id)) continue;
    seenIds.add(runner_id);
    seenDeclaredCloth.add(horse_no);
    runners.push({
      runner_id,
      horse_no,
      horse_name: null,
      win_odds: winMap[key] ?? null,
      place_odds: plaMap[key] ?? null,
      status: "Declared",
      raw_status: null,
      final_position: null,
    });
  }
  runners.sort(
    (a, b) =>
      a.horse_no - b.horse_no ||
      a.status.localeCompare(b.status) ||
      a.runner_id.localeCompare(b.runner_id),
  );

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
      last_update: lastUpdate,
    },
  };
}
