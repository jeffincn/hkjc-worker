/**
 * Live-poll control: configurable interval, per-HKT-day GraphQL request
 * budget throttle, and source-block exponential backoff.
 *
 * Effective interval = max(schedule interval, budget throttle, backoff).
 */
import type { Env } from "../env";
import { envNum } from "../env";

export const DEFAULT_POLL_INTERVAL_MS = 3000;
export const MIN_POLL_INTERVAL_MS = 1000;
export const MAX_POLL_INTERVAL_MS = 600_000;
export const DEFAULT_DAILY_REQUEST_BUDGET = 30_000;
/** GraphQL requests per poll tick (meeting tree + WIN/PLA odds). */
export const REQUESTS_PER_TICK = 2;
/** Throttle ladder (ms). Steps below the configured base are dropped. */
export const THROTTLE_STEPS_MS = [3000, 5000, 10_000, 30_000, 60_000];
/** Interval when the daily budget is already exhausted. */
export const BUDGET_EXHAUSTED_INTERVAL_MS = 300_000;
export const BACKOFF_CAP_MS = 60_000;
/** Consecutive plain network/HTTP failures treated as a block. */
export const NETWORK_FAILURES_BEFORE_BLOCK = 3;

const HK_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function resolvePollIntervalMs(env: Env): number {
  const raw = envNum(env, "POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.round(raw)));
}

export function resolveDailyRequestBudget(env: Env): number {
  const n = envNum(env, "DAILY_REQUEST_BUDGET", DEFAULT_DAILY_REQUEST_BUDGET);
  return n > 0 ? Math.floor(n) : DEFAULT_DAILY_REQUEST_BUDGET;
}

/** YYYY-MM-DD in Asia/Hong_Kong (fixed UTC+8, no DST). */
export function hkDay(nowMs: number): string {
  return new Date(nowMs + HK_OFFSET_MS).toISOString().slice(0, 10);
}

export function msUntilHkMidnight(nowMs: number): number {
  const local = nowMs + HK_OFFSET_MS;
  return DAY_MS - (((local % DAY_MS) + DAY_MS) % DAY_MS);
}

/**
 * Pick the fastest ladder step whose projected total for the rest of the
 * horizon stays within budget. Horizon = until `horizonEndMs` (expected
 * meeting end) capped at HKT midnight.
 */
export function throttleIntervalMs(args: {
  baseMs: number;
  usedToday: number;
  budget: number;
  nowMs: number;
  horizonEndMs?: number | null;
  requestsPerTick?: number;
}): number {
  const perTick = args.requestsPerTick ?? REQUESTS_PER_TICK;
  if (args.usedToday >= args.budget) return Math.max(args.baseMs, BUDGET_EXHAUSTED_INTERVAL_MS);
  const midnight = msUntilHkMidnight(args.nowMs);
  const toEnd =
    args.horizonEndMs != null && Number.isFinite(args.horizonEndMs)
      ? Math.max(0, args.horizonEndMs - args.nowMs)
      : midnight;
  const horizon = Math.min(midnight, toEnd);
  const steps = [args.baseMs, ...THROTTLE_STEPS_MS.filter((s) => s > args.baseMs)];
  for (const step of steps) {
    const projected = args.usedToday + Math.ceil(horizon / step) * perTick;
    if (projected <= args.budget) return step;
  }
  return Math.max(args.baseMs, BUDGET_EXHAUSTED_INTERVAL_MS);
}

export interface BlockState {
  blocked: boolean;
  /** Backoff exponent; 0 = healthy. */
  level: number;
  consecutive_failures: number;
  reason: string | null;
  since: string | null;
  last_error_at: string | null;
}

export const HEALTHY_BLOCK_STATE: BlockState = {
  blocked: false,
  level: 0,
  consecutive_failures: 0,
  reason: null,
  since: null,
  last_error_at: null,
};

export type FetchOutcome =
  | { kind: "ok" }
  | { kind: "blocked"; reason: string }
  | { kind: "error"; reason: string }
  /**
   * D1 / Durable Object storage / quota failures — never attributed to HKJC.
   * Does not open or extend source_block; leaves prior state unchanged.
   */
  | { kind: "storage"; reason: string };

export interface BlockTransition {
  state: BlockState;
  /** Became blocked this tick → emit source_blocked. */
  becameBlocked: boolean;
  /** Fully recovered this tick → emit source_recovered. */
  recovered: boolean;
}

/**
 * Exponential backoff on 403/429/challenge (immediately) or after N
 * consecutive network errors.
 *
 * Storage/D1 errors never open source_block. A successful HKJC fetch (`ok`)
 * clears the block immediately so a prior misclassified D1 quota block heals
 * as soon as GraphQL succeeds again (`recovered` fires when previously blocked).
 */
export function nextBlockState(prev: BlockState, outcome: FetchOutcome, nowIso: string): BlockTransition {
  if (outcome.kind === "storage") {
    // Ignore — do not count toward HKJC source_block.
    return { state: prev, becameBlocked: false, recovered: false };
  }
  if (outcome.kind === "ok") {
    if (prev.level === 0 && !prev.blocked) {
      return { state: { ...HEALTHY_BLOCK_STATE }, becameBlocked: false, recovered: false };
    }
    // Successful fetch: clear immediately when previously blocked for any reason
    // (including legacy misclassified D1 quota blocks).
    if (prev.blocked || prev.level > 0) {
      return {
        state: { ...HEALTHY_BLOCK_STATE },
        becameBlocked: false,
        recovered: prev.blocked,
      };
    }
    return { state: { ...HEALTHY_BLOCK_STATE }, becameBlocked: false, recovered: false };
  }
  const failures = prev.consecutive_failures + 1;
  const isBlock = outcome.kind === "blocked" || failures >= NETWORK_FAILURES_BEFORE_BLOCK;
  if (!isBlock) {
    return {
      state: { ...prev, consecutive_failures: failures, last_error_at: nowIso },
      becameBlocked: false,
      recovered: false,
    };
  }
  const state: BlockState = {
    blocked: true,
    level: Math.min(prev.level + 1, 10),
    consecutive_failures: failures,
    reason: outcome.reason,
    since: prev.blocked ? prev.since : nowIso,
    last_error_at: nowIso,
  };
  return { state, becameBlocked: !prev.blocked, recovered: false };
}

export function backoffIntervalMs(baseMs: number, state: BlockState): number {
  if (state.level <= 0) return baseMs;
  return Math.min(BACKOFF_CAP_MS, baseMs * 2 ** state.level);
}

export function effectiveIntervalMs(parts: {
  scheduleMs: number;
  throttleMs: number;
  backoffMs: number;
}): number {
  return Math.max(parts.scheduleMs, parts.throttleMs, parts.backoffMs);
}
