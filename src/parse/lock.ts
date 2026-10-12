import type { RaceOddsSnapshot } from "./odds";

/** Emit lock only when post time is within this window before now (or past). */
export const LOCK_POST_TIME_WINDOW_MS = 15 * 60 * 1000;

const OPEN_SELL_STATUSES = new Set(["START_SELL", "SELLING", "SELL_STARTED"]);

export function isOpenSellStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return OPEN_SELL_STATUSES.has(status.toUpperCase());
}

/** Race post time is within 15 minutes before now, or already past (HK wall times as ISO). */
export function isRaceNearOrPastPost(
  postTime: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!postTime || !String(postTime).trim()) return false;
  const postMs = Date.parse(postTime);
  if (!Number.isFinite(postMs)) return false;
  return postMs <= nowMs + LOCK_POST_TIME_WINDOW_MS;
}

export function snapshotHasOdds(snap: RaceOddsSnapshot): boolean {
  if (Object.keys(snap.payload.win).length > 0) return true;
  if (Object.keys(snap.payload.pla).length > 0) return true;
  return snap.runners.some((r) => r.win_odds != null || r.place_odds != null);
}

/**
 * Un-opened / pre-sale pool shells: no lastUpdate and no odds.
 * These must not be stored or used to trigger lock / odds_update.
 */
export function isEmptyPreSaleSnapshot(snap: RaceOddsSnapshot): boolean {
  const last = snap.payload.last_update;
  const hasLast = last != null && String(last).trim() !== "";
  return !hasLast && !snapshotHasOdds(snap);
}

export function isStorableOddsSnapshot(snap: RaceOddsSnapshot): boolean {
  return !isEmptyPreSaleSnapshot(snap);
}

/**
 * Genuine lock: STOP_SELL after the pool was (or is) meaningfully open,
 * and only near/after post time — not far-future pre-sale STOP_SELL.
 */
export function shouldEmitLock(args: {
  poolStatus: string | null | undefined;
  postTime: string | null | undefined;
  nowMs?: number;
  /** Current snapshot has odds, or a prior open/selling snapshot existed. */
  wasOpenOrHasOdds: boolean;
}): boolean {
  if ((args.poolStatus ?? "").toUpperCase() !== "STOP_SELL") return false;
  if (!isRaceNearOrPastPost(args.postTime, args.nowMs ?? Date.now())) return false;
  if (!args.wasOpenOrHasOdds) return false;
  return true;
}
