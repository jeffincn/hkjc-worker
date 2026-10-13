import type { Env } from "../env";
import { envNum } from "../env";
import { rowsWrittenFromMeta } from "../util/d1";

/**
 * Default daily write budget ≈ 80% of a paid D1 plan's typical high cap.
 * Override with D1_DAILY_WRITE_BUDGET. Degrade mode engages at 80% of budget.
 */
export const DEFAULT_D1_DAILY_WRITE_BUDGET = 40_000_000;
export const D1_DEGRADE_RATIO = 0.8;

/** In-isolate pending count before flush to worker_meta (avoids write amplification). */
const FLUSH_EVERY = 50;
const FLUSH_MS = 30_000;

interface WriteCounterState {
  day: string;
  pending: number;
  cachedTotal: number;
  lastFlushMs: number;
}

let counter: WriteCounterState | null = null;

export function utcDay(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function d1DailyWriteBudget(env: Env): number {
  const n = envNum(env, "D1_DAILY_WRITE_BUDGET", DEFAULT_D1_DAILY_WRITE_BUDGET);
  return n > 0 ? Math.floor(n) : DEFAULT_D1_DAILY_WRITE_BUDGET;
}

function metaKey(day: string): string {
  return `d1_writes_utc_${day}`;
}

/** Test helper — reset in-isolate counter. */
export function resetD1WriteCounter(): void {
  counter = null;
}

export async function getD1WritesToday(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<number> {
  const day = utcDay(nowMs);
  const row = await db
    .prepare(`SELECT value FROM worker_meta WHERE key=?`)
    .bind(metaKey(day))
    .first<{ value: string }>();
  const stored = Math.max(0, Number(row?.value ?? 0) || 0);
  if (counter && counter.day === day) {
    return stored + counter.pending;
  }
  return stored;
}

export interface D1WriteStats {
  day: string;
  today: number;
  budget: number;
  remaining: number;
  degrade: boolean;
  degrade_threshold: number;
}

export async function getD1WriteStats(
  env: Env,
  nowMs: number = Date.now(),
): Promise<D1WriteStats> {
  const day = utcDay(nowMs);
  const budget = d1DailyWriteBudget(env);
  const today = await getD1WritesToday(env.DB, nowMs);
  const threshold = Math.floor(budget * D1_DEGRADE_RATIO);
  return {
    day,
    today,
    budget,
    remaining: Math.max(0, budget - today),
    degrade: today >= threshold,
    degrade_threshold: threshold,
  };
}

export async function isD1WriteDegraded(
  env: Env,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const stats = await getD1WriteStats(env, nowMs);
  return stats.degrade;
}

/**
 * Record rows written from a D1 statement result. Batches into worker_meta
 * to avoid amplifying write load.
 */
export async function trackD1Result(
  env: Env,
  result: { meta?: D1Meta } | null | undefined,
  nowMs: number = Date.now(),
): Promise<void> {
  const n = rowsWrittenFromMeta(result?.meta ?? null);
  if (n <= 0) return;
  await trackD1RowsWritten(env, n, nowMs);
}

export async function trackD1RowsWritten(
  env: Env,
  n: number,
  nowMs: number = Date.now(),
): Promise<void> {
  if (n <= 0) return;
  const day = utcDay(nowMs);
  if (!counter || counter.day !== day) {
    counter = { day, pending: 0, cachedTotal: 0, lastFlushMs: 0 };
  }
  counter.pending += n;
  if (
    counter.pending >= FLUSH_EVERY ||
    nowMs - counter.lastFlushMs >= FLUSH_MS
  ) {
    await flushD1WriteCounter(env, nowMs);
  }
}

export async function flushD1WriteCounter(
  env: Env,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!counter || counter.pending <= 0) return;
  const day = counter.day;
  const delta = counter.pending;
  counter.pending = 0;
  counter.lastFlushMs = nowMs;
  const key = metaKey(day);
  const row = await env.DB.prepare(`SELECT value FROM worker_meta WHERE key=?`)
    .bind(key)
    .first<{ value: string }>();
  const cur = Math.max(0, Number(row?.value ?? 0) || 0);
  const next = cur + delta;
  // Direct write — do not recurse through setMeta/track to avoid loops.
  await env.DB.prepare(
    `INSERT INTO worker_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  )
    .bind(key, String(next), new Date(nowMs).toISOString())
    .run();
  counter.cachedTotal = next;
}

/** Write classes kept even when degraded (odds / results / dividends / critical meta). */
export type D1WriteClass =
  | "essential"
  | "odds"
  | "results"
  | "dividends"
  | "push_log"
  | "raw_dup"
  | "meta_ok"
  | "other";

export function mayWriteWhenDegraded(cls: D1WriteClass): boolean {
  return (
    cls === "essential" ||
    cls === "odds" ||
    cls === "results" ||
    cls === "dividends"
  );
}

/**
 * Gate a non-essential write. Returns false when degraded and class is skippable.
 * Essential/odds/results/dividends always allowed.
 */
export async function allowD1Write(
  env: Env,
  cls: D1WriteClass,
): Promise<boolean> {
  if (mayWriteWhenDegraded(cls)) return true;
  return !(await isD1WriteDegraded(env));
}
