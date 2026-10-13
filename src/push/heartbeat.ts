import type { Env } from "../env";
import { THIRTY_MIN_MS } from "../poll/interval";
import {
  heartbeatIntervalMs,
  resolveEffectiveHeartbeatIntervalMs,
  shouldEmitHeartbeat,
  DEFAULT_HEARTBEAT_INTERVAL_SEC,
  DEFAULT_OFFDAY_HEARTBEAT_INTERVAL_SEC,
} from "./odds-policy";

/** @deprecated Prefer raceday HEARTBEAT_INTERVAL_SEC / offday OFFDAY_*. */
export const NO_UPDATE_FAST_MS = 60_000;
/** Matches DEFAULT_HEARTBEAT_INTERVAL_SEC (5 min) — raceday high-freq. */
export const NO_UPDATE_SLOW_MS = DEFAULT_HEARTBEAT_INTERVAL_SEC * 1000;
/** Off-day / outside raceday window default (30 min). */
export const NO_UPDATE_OFFDAY_MS = DEFAULT_OFFDAY_HEARTBEAT_INTERVAL_SEC * 1000;

export { shouldEmitHeartbeat, resolveEffectiveHeartbeatIntervalMs };

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
 * Rate-limit no_update / keepalive: at most once per effective heartbeat
 * interval, and only when nothing else was pushed in that window.
 */
export function shouldEmitNoUpdate(args: {
  nowMs: number;
  /** Last time any push was emitted for this meeting (not only no_update). */
  lastAnyPushAtMs: number | null;
  /** @deprecated ignored — use inHighFreqWindow / heartbeatIntervalMs. */
  inFastWindow?: boolean;
  /** @deprecated alias of lastAnyPushAtMs for older call sites/tests. */
  lastNoUpdateAtMs?: number | null;
  heartbeatIntervalMs?: number;
}): boolean {
  const last =
    args.lastAnyPushAtMs ?? args.lastNoUpdateAtMs ?? null;
  return shouldEmitHeartbeat({
    nowMs: args.nowMs,
    lastAnyPushAtMs: last,
    heartbeatIntervalMs: args.heartbeatIntervalMs ?? NO_UPDATE_SLOW_MS,
  });
}

/** Raceday high-freq heartbeat (HEARTBEAT_INTERVAL_SEC). */
export function resolveHeartbeatIntervalMs(env: Env): number {
  return heartbeatIntervalMs(env);
}
