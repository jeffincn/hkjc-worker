import { THIRTY_MIN_MS } from "../poll/interval";

export const NO_UPDATE_FAST_MS = 60_000;
export const NO_UPDATE_SLOW_MS = 5 * 60_000;

/** Same definition as MeetingPoller fast poll window: post within ≤30 min (incl. past). */
export function isInFastWindow(
  postTimeIso: string | null | undefined,
  nowMs: number,
): boolean {
  if (!postTimeIso) return false;
  const postMs = Date.parse(postTimeIso);
  if (!Number.isFinite(postMs)) return false;
  return postMs - nowMs <= THIRTY_MIN_MS;
}

/**
 * Rate-limit no_update: ≤1/60s in fast window, ≤1/5min otherwise.
 * Returns true when a heartbeat should be emitted now.
 */
export function shouldEmitNoUpdate(args: {
  nowMs: number;
  lastNoUpdateAtMs: number | null;
  inFastWindow: boolean;
}): boolean {
  const minInterval = args.inFastWindow ? NO_UPDATE_FAST_MS : NO_UPDATE_SLOW_MS;
  if (args.lastNoUpdateAtMs == null) return true;
  return args.nowMs - args.lastNoUpdateAtMs >= minInterval;
}
