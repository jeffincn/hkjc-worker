import type { PmPoolRaw } from "../graphql/types";

/** True when a pool carries at least one dividend entry. */
export function poolHasDividends(pool: PmPoolRaw): boolean {
  return Array.isArray(pool.dividends) && pool.dividends.length > 0;
}

/** True when any pool in the list has a non-empty dividends array. */
export function hasAnyDividends(pools: PmPoolRaw[]): boolean {
  return pools.some(poolHasDividends);
}

/**
 * Pool / dividend status trusted for WIN winComb → winner fallback (issue #29 R1).
 * Matches OFFICIAL and common post-race payout statuses; empty status allowed when
 * dividends are already present (e.g. officialOnly query / rbc).
 */
export function isOfficialWinDividendPool(pool: PmPoolRaw): boolean {
  if (pool.oddsType !== "WIN" || !poolHasDividends(pool)) return false;
  const st = (pool.status ?? "").toUpperCase();
  if (
    !st ||
    st.includes("OFFICIAL") ||
    st.includes("PAYOUT") ||
    st.includes("RESULT")
  ) {
    return true;
  }
  return (pool.dividends ?? []).some((d) =>
    (d.status ?? "").toUpperCase().includes("OFFICIAL"),
  );
}

/** WIN winComb horse numbers (winners; dead-heat may yield multiple). */
export function winCombWinnerHorseNos(pools: PmPoolRaw[]): number[] {
  const win = pools.find(isOfficialWinDividendPool);
  if (!win) return [];
  const out: number[] = [];
  for (const d of win.dividends ?? []) {
    const n = Number(d.winComb);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return [...new Set(out)];
}

/** True when every position is missing or ≤0 (GraphQL unparsed). */
export function positionsUnresolved(
  positions: Array<number | null | undefined>,
): boolean {
  if (positions.length === 0) return true;
  return positions.every((p) => p == null || p <= 0);
}

/** True when any runner already holds final_position === 1. */
export function hasFinalPositionOne(
  positions: Array<number | null | undefined>,
): boolean {
  return positions.some((p) => p != null && p === 1);
}

/**
 * Shared gate for WIN winComb → final_position=1 fallback (issue #31 R1/R4).
 *
 * Fires when position-1 is missing:
 * - (a) all positions unresolved (null/≤0), or
 * - (b) some official placings exist but none is 1 (e.g. [null,null,2..11]).
 *
 * Callers still require usable WIN winComb to apply; missing winComb → warn (R5).
 */
export function shouldApplyWinCombFallback(
  positions: Array<number | null | undefined>,
): boolean {
  return !hasFinalPositionOne(positions);
}

export interface WinCombFallbackResult {
  /** True when at least one runner was set to final_position=1. */
  applied: boolean;
  winners: number[];
  /** True when WIN winComb listed 2+ horses (dead heat). */
  dead_heat: boolean;
  /** Why fallback was skipped / needed. */
  reason:
    | "winner_already_present"
    | "applied"
    | "no_win_dividends"
    /** @deprecated alias of winner_already_present (pre-#31). */
    | "official_positions_present";
}

/**
 * When position-1 is missing, set WIN winComb horses to final_position=1
 * where currently null/≤0 (R1/R2). Never overwrites any official >0 placing.
 * Multiple winComb → dead_heat=true; sole winner → dead_heat=null (R3).
 * Mutates `runners` in place.
 */
export function applyWinCombWinnerFallback(args: {
  runners: Array<{
    horse_no: number;
    final_position: number | null;
    dead_heat?: boolean | null;
  }>;
  pools: PmPoolRaw[];
}): WinCombFallbackResult {
  const positions = args.runners.map((r) => r.final_position);
  if (!shouldApplyWinCombFallback(positions)) {
    return {
      applied: false,
      winners: [],
      dead_heat: false,
      reason: "winner_already_present",
    };
  }
  const winners = winCombWinnerHorseNos(args.pools);
  if (winners.length === 0) {
    return {
      applied: false,
      winners: [],
      dead_heat: false,
      reason: "no_win_dividends",
    };
  }
  const deadHeat = winners.length > 1;
  const winnerSet = new Set(winners);
  let applied = false;
  for (const r of args.runners) {
    if (!winnerSet.has(r.horse_no)) continue;
    // R2: never overwrite any official placing >0.
    if (r.final_position != null && r.final_position > 0) continue;
    r.final_position = 1;
    r.dead_heat = deadHeat ? true : null;
    applied = true;
  }
  // Winner present in dividends but not yet in runners list — still "applied"
  // for callers that will upsert by horse_no.
  if (!applied && winners.length > 0) {
    return { applied: true, winners, dead_heat: deadHeat, reason: "applied" };
  }
  return {
    applied,
    winners,
    dead_heat: deadHeat,
    reason: applied ? "applied" : "no_win_dividends",
  };
}

/**
 * Canonical payload for dividends change detection.
 * Excludes status / lastUpdateTime so DEFINED←INITIAL churn on empty
 * pre-race pools does not look like a dividends update.
 */
export function dividendsHashPayload(pools: PmPoolRaw[]): Array<{
  oddsType: string | null;
  race_no: number | null;
  dividends: NonNullable<PmPoolRaw["dividends"]>;
}> {
  return pools
    .filter(poolHasDividends)
    .map((p) => ({
      oddsType: p.oddsType ?? null,
      race_no: p.leg?.number ?? p.leg?.races?.[0] ?? null,
      dividends: p.dividends ?? [],
    }))
    .sort((a, b) => {
      const ra = a.race_no ?? -1;
      const rb = b.race_no ?? -1;
      if (ra !== rb) return ra - rb;
      return String(a.oddsType).localeCompare(String(b.oddsType));
    });
}

/** Count of pools that actually have dividend rows (for push meta). */
export function dividendsPoolCount(pools: PmPoolRaw[]): number {
  return pools.filter(poolHasDividends).length;
}
