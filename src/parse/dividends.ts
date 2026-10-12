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
