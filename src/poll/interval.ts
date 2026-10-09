/**
 * Poll interval scheduling by race post time (Asia/Hong_Kong wall clock).
 * - > 2 h before post: 5 min (idle)
 * - 30 min–2 h before post: 60s (slow)
 * - <= 30 min before post: POLL_INTERVAL_SEC (default 10s, fast)
 * - after post / locked: still use fast interval until result, or caller stops
 */

const THIRTY_MIN_MS = 30 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export function computePollIntervalMs(args: {
  nowMs: number;
  postTimeIso: string | null | undefined;
  fastIntervalSec?: number;
  slowIntervalSec?: number;
  idleIntervalSec?: number;
}): number {
  const fast = (args.fastIntervalSec ?? 10) * 1000;
  const slow = (args.slowIntervalSec ?? 60) * 1000;
  const idle = (args.idleIntervalSec ?? 300) * 1000;
  if (!args.postTimeIso) return idle;
  const postMs = Date.parse(args.postTimeIso);
  if (!Number.isFinite(postMs)) return idle;
  const delta = postMs - args.nowMs;
  if (delta <= THIRTY_MIN_MS) return fast;
  if (delta <= TWO_HOURS_MS) return slow;
  return idle;
}

/** Earliest upcoming (or in-progress) race post time for interval decisions. */
export function selectRelevantPostTime(
  races: Array<{ post_time: string | null; status?: string | null }>,
  nowMs: number,
): string | null {
  const open = races.filter((r) => {
    const s = (r.status ?? "").toUpperCase();
    return s !== "RESULT" && s !== "CLOSED" && s !== "ABANDONED";
  });
  const pool = open.length > 0 ? open : races;
  let best: string | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const r of pool) {
    if (!r.post_time) continue;
    const t = Date.parse(r.post_time);
    if (!Number.isFinite(t)) continue;
    // Prefer soonest future, else most recent past
    const score = t >= nowMs ? t - nowMs : 1e15 + (nowMs - t);
    if (score < bestDelta) {
      bestDelta = score;
      best = r.post_time;
    }
  }
  return best;
}

export { THIRTY_MIN_MS, TWO_HOURS_MS };
