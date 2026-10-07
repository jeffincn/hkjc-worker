/**
 * Poll interval scheduling by race post time (Asia/Hong_Kong wall clock).
 * - > 30 min before post: 60s
 * - <= 30 min before post: POLL_INTERVAL_SEC (default 10s)
 * - after post / locked: still use fast interval until result, or caller stops
 */

const THIRTY_MIN_MS = 30 * 60 * 1000;

export function computePollIntervalMs(args: {
  nowMs: number;
  postTimeIso: string | null | undefined;
  fastIntervalSec?: number;
  slowIntervalSec?: number;
}): number {
  const fast = (args.fastIntervalSec ?? 10) * 1000;
  const slow = (args.slowIntervalSec ?? 60) * 1000;
  if (!args.postTimeIso) return slow;
  const postMs = Date.parse(args.postTimeIso);
  if (!Number.isFinite(postMs)) return slow;
  const delta = postMs - args.nowMs;
  if (delta <= THIRTY_MIN_MS) return fast;
  return slow;
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
    const delta = Math.abs(t - nowMs);
    // Prefer soonest future, else most recent past
    const score = t >= nowMs ? t - nowMs : 1e15 + (nowMs - t);
    if (score < bestDelta) {
      bestDelta = score;
      best = r.post_time;
    }
  }
  return best;
}

export { THIRTY_MIN_MS };
