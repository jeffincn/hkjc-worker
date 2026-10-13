import type { Env } from "../env";
import { envNum } from "../env";
import { getMeta, setMeta } from "../store/db";

export const DEFAULT_PUSH_RATE_PER_SUB_PER_SEC = 2;

const WINDOW_PREFIX = "push_rate_window_";
const DELAY_COUNT_PREFIX = "push_rate_delay_count_";

export function pushRatePerSubPerSec(env: Env): number {
  return Math.max(1, envNum(env, "PUSH_RATE_PER_SUB_PER_SEC", DEFAULT_PUSH_RATE_PER_SUB_PER_SEC));
}

function subKey(subscriberId: number | null): string {
  return subscriberId == null ? "fallback" : String(subscriberId);
}

function windowMetaKey(subscriberId: number | null): string {
  return WINDOW_PREFIX + subKey(subscriberId);
}

function delayCountMetaKey(subscriberId: number | null): string {
  return DELAY_COUNT_PREFIX + subKey(subscriberId);
}

export interface DeliverySlotReservation {
  /** Seconds to delay before HTTP delivery (0 = send immediately). */
  delaySeconds: number;
  /** Absolute ms when this slot may fire. */
  slotAtMs: number;
}

function parseWindow(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

/**
 * Reserve the next delivery slot for a subscriber at PUSH_RATE_PER_SUB_PER_SEC.
 * Sliding 1s window: up to `rate` deliveries may proceed with delaySeconds=0;
 * excess is delayed (never dropped). Queue delaySeconds is integer seconds, so
 * delayed messages wait at least 1s for the window to refill.
 */
export async function reserveDeliverySlot(
  env: Env,
  subscriberId: number | null,
  nowMs: number = Date.now(),
): Promise<DeliverySlotReservation> {
  const rate = pushRatePerSubPerSec(env);
  const intervalMs = Math.ceil(1000 / rate);
  const key = windowMetaKey(subscriberId);
  const stamps = parseWindow(await getMeta(env.DB, key));

  // Keep stamps that still occupy the current or future window.
  const active = stamps.filter((t) => t > nowMs - 1000);

  if (active.filter((t) => t <= nowMs).length < rate && active.every((t) => t <= nowMs)) {
    // Simple case: room in the current second and no future reservations.
    const inWindow = active.filter((t) => nowMs - t < 1000);
    if (inWindow.length < rate) {
      const next = [...inWindow, nowMs];
      await setMeta(env.DB, key, JSON.stringify(next));
      return { delaySeconds: 0, slotAtMs: nowMs };
    }
  }

  // Count how many slots already claimed in [nowMs-1000, nowMs].
  const inWindow = active.filter((t) => t <= nowMs && nowMs - t < 1000);
  if (inWindow.length < rate) {
    // Still room now (even if some future stamps exist for later).
    const next = [...active, nowMs].filter((t) => t > nowMs - 1000);
    await setMeta(env.DB, key, JSON.stringify(next));
    return { delaySeconds: 0, slotAtMs: nowMs };
  }

  // Window full: schedule after the earliest stamp exits, behind any futures.
  const oldest = Math.min(...inWindow);
  const futures = active.filter((t) => t > nowMs);
  const slotAtMs =
    futures.length > 0
      ? Math.max(...futures) + intervalMs
      : oldest + 1000;
  const waitMs = Math.max(1, slotAtMs - nowMs);
  const delaySeconds = Math.max(1, Math.ceil(waitMs / 1000));

  const next = [...active, slotAtMs].filter((t) => t > nowMs - 1000 || t >= nowMs);
  await setMeta(env.DB, key, JSON.stringify(next));
  await bumpRateLimitDelayCount(env, subscriberId);
  return { delaySeconds, slotAtMs };
}

export async function bumpRateLimitDelayCount(
  env: Env,
  subscriberId: number | null,
  delta = 1,
): Promise<void> {
  const key = delayCountMetaKey(subscriberId);
  const raw = await getMeta(env.DB, key);
  const cur = Math.max(0, Number(raw ?? 0) || 0);
  await setMeta(env.DB, key, String(cur + delta));
}

export async function getRateLimitDelayCount(
  env: Env,
  subscriberId: number | null,
): Promise<number> {
  const raw = await getMeta(env.DB, delayCountMetaKey(subscriberId));
  return Math.max(0, Number(raw ?? 0) || 0);
}

export async function getTotalRateLimitDelays(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT value FROM worker_meta WHERE key LIKE ?`,
  )
    .bind(DELAY_COUNT_PREFIX + "%")
    .all<{ value: string }>();
  let total = 0;
  for (const row of results ?? []) {
    total += Math.max(0, Number(row.value ?? 0) || 0);
  }
  return total;
}

export interface SubscriberRateLimitStats {
  subscriber_id: number | null;
  rate_limit_delays: number;
}

/** Stats for known subscribers + fallback key when present. */
export async function listRateLimitStats(
  env: Env,
  subscriberIds: Array<number | null>,
): Promise<SubscriberRateLimitStats[]> {
  const out: SubscriberRateLimitStats[] = [];
  const seen = new Set<string>();
  for (const id of subscriberIds) {
    const k = subKey(id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      subscriber_id: id,
      rate_limit_delays: await getRateLimitDelayCount(env, id),
    });
  }
  return out;
}
