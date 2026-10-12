import type { Env } from "../env";
import { envBool, envNum } from "../env";
import type { PushEnvelope, PushEvent } from "./envelope";
import { isLivePushEvent } from "./envelope";
import { getPushEventById } from "./ledger";
import {
  attemptDelivery,
  type ResolvedTarget,
  type SubscriberDelivery,
} from "./delivery";
import { enqueueDeliveries, hasPushQueue } from "./queue";
import {
  PUSH_1_1_DEPLOY_CUTOFF,
  ensureEventId,
  requireEventId,
} from "./event-id";
import { enqueueRetry, GAVE_UP, nextBackoffMinutes } from "./pending";
import {
  countSubscribers,
  getSubscriber,
  listEnabledSubscribers,
  type PushSubscriber,
} from "./subscribers";

export { hmacSha256Hex, type SubscriberDelivery } from "./delivery";
export { enqueueRetry, GAVE_UP, nextBackoffMinutes } from "./pending";
export {
  PUSH_1_1_DEPLOY_CUTOFF,
  ensureEventId,
  requireEventId,
  isLegacyGiveUpCandidate,
} from "./event-id";

const LEGACY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_MAX_PER_RUN = 5;
/** Scan window larger than the send cap so 429 skips can still fill the budget. */
const RETRY_SCAN_MULTIPLIER = 10;

/** Shared per-invocation budget for flushDueRetries + piggybackPending. */
export interface RetryRunState {
  sent: number;
  max: number;
  /** Subscriber keys that returned HTTP 429 earlier in this run. */
  rateLimitedSubscribers: Set<string>;
}

export function createRetryRunState(env: Env): RetryRunState {
  return {
    sent: 0,
    max: Math.max(0, envNum(env, "PUSH_RETRY_MAX_PER_RUN", DEFAULT_RETRY_MAX_PER_RUN)),
    rateLimitedSubscribers: new Set(),
  };
}

function subscriberKey(subscriberId: number | null): string {
  return subscriberId == null ? "fallback" : String(subscriberId);
}

function isGaveUp(lastError: string | null | undefined): boolean {
  return lastError === GAVE_UP;
}

/**
 * Mark ONLY pre-1.1 legacy rows as gave_up (row kept, never deleted).
 *
 * A row must match ALL of:
 * - empty/null event_id
 * - created_at older than 24h
 * - created_at before PUSH_1_1_DEPLOY_CUTOFF (post-deploy rows never abandoned)
 * - payload_json is not schema hkjc-push/1.1
 *
 * Live race-day (post-1.1) pushes can never match — they always carry event_id
 * (see ensureEventId / requireEventId) and/or were created after the cutoff.
 */
export async function giveUpStaleLegacyPending(env: Env): Promise<number> {
  const ageCutoff = new Date(Date.now() - LEGACY_MAX_AGE_MS).toISOString();
  const result = await env.DB.prepare(
    `UPDATE pending_pushes
     SET last_error = ?, next_retry_at = NULL
     WHERE (event_id IS NULL OR event_id = '')
       AND created_at < ?
       AND created_at < ?
       AND IFNULL(last_error, '') != ?
       AND IFNULL(payload_json, '') NOT LIKE '%"schema":"hkjc-push/1.1"%'
       AND IFNULL(payload_json, '') NOT LIKE '%"schema": "hkjc-push/1.1"%'`,
  )
    .bind(GAVE_UP, ageCutoff, PUSH_1_1_DEPLOY_CUTOFF, GAVE_UP)
    .run();
  return result.meta?.changes ?? 0;
}

/** Cheap pending_pushes counters for /health. */
export async function countPendingPushStats(env: Env): Promise<{
  due: number;
  deferred: number;
  gave_up: number;
  active: number;
}> {
  const now = new Date().toISOString();
  const due = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM pending_pushes
     WHERE next_retry_at IS NOT NULL AND next_retry_at <= ?
       AND IFNULL(last_error, '') != ?`,
  )
    .bind(now, GAVE_UP)
    .first<{ n: number }>();
  const deferred = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM pending_pushes
     WHERE (next_retry_at IS NULL OR next_retry_at > ?)
       AND IFNULL(last_error, '') != ?`,
  )
    .bind(now, GAVE_UP)
    .first<{ n: number }>();
  const gave_up = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM pending_pushes WHERE last_error = ?`,
  )
    .bind(GAVE_UP)
    .first<{ n: number }>();
  return {
    due: due?.n ?? 0,
    deferred: deferred?.n ?? 0,
    gave_up: gave_up?.n ?? 0,
    active: (due?.n ?? 0) + (deferred?.n ?? 0),
  };
}

export interface PushResult {
  skipped: boolean;
  reason?: string;
  http_status: number | null;
  success: boolean;
  error_message?: string;
  retry_count: number;
  /** Per-subscriber delivery outcomes when fan-out ran. */
  deliveries?: SubscriberDelivery[];
  /** True when deliveries were enqueued to PUSH_QUEUE. */
  queued?: boolean;
}

/**
 * Resolve delivery targets: enabled subscriber rows, or PUSH_TARGET_URL
 * fallback only when the subscribers table has zero rows.
 */
export async function resolvePushTargets(env: Env): Promise<ResolvedTarget[]> {
  const total = await countSubscribers(env);
  if (total > 0) {
    const enabled = await listEnabledSubscribers(env);
    return enabled.map((s) => ({
      subscriber_id: s.id,
      url: s.url,
      secret: s.secret,
    }));
  }

  const fallback = env.PUSH_TARGET_URL?.trim();
  if (!fallback) return [];
  return [
    {
      subscriber_id: null,
      url: fallback,
      secret: env.PUSH_SECRET?.trim() || null,
    },
  ];
}

/**
 * Fan-out an already-ledgered envelope.
 * Prefer Cloudflare Queue (one invocation per delivery); fall back to direct
 * HTTP when PUSH_QUEUE is unbound (tests / local).
 */
export async function sendPush(
  env: Env,
  envelope: PushEnvelope,
  opts?: { fetchImpl?: typeof fetch; force?: boolean; forceDirect?: boolean },
): Promise<PushResult> {
  const liveEnabled = envBool(env, "LIVE_PUSH_ENABLED", false);
  if (!opts?.force && isLivePushEvent(envelope.event) && !liveEnabled) {
    return {
      skipped: true,
      reason: "LIVE_PUSH_ENABLED=false",
      http_status: null,
      success: false,
      retry_count: 0,
    };
  }

  const targets = await resolvePushTargets(env);
  if (targets.length === 0) {
    return {
      skipped: true,
      reason: "no push subscribers and PUSH_TARGET_URL not set",
      http_status: null,
      success: false,
      retry_count: 0,
    };
  }

  // Post-1.1: never fan-out / enqueue without a non-empty event_id.
  requireEventId(ensureEventId(envelope));

  // Custom fetchImpl (unit tests) always uses the direct path so injected
  // fetch is exercised; production consumers omit fetchImpl and use the queue.
  const useQueue =
    !opts?.forceDirect && !opts?.fetchImpl && hasPushQueue(env);
  const deliveries = await enqueueDeliveries(env, envelope, targets, {
    fetchImpl: opts?.fetchImpl,
    forceDirect: !useQueue,
  });

  const httpDeliveries = deliveries.filter((d) => !d.queued && !d.skipped_circuit);
  const anySuccess = deliveries.some((d) => d.success);
  const firstSuccess = httpDeliveries.find((d) => d.success) ?? deliveries.find((d) => d.success);
  const firstFailure = deliveries.find((d) => !d.success && !d.skipped_circuit);

  return {
    skipped: false,
    http_status: firstSuccess?.http_status ?? firstFailure?.http_status ?? null,
    success: anySuccess,
    error_message: anySuccess
      ? undefined
      : firstFailure?.error_message ?? "all subscribers failed",
    retry_count: 0,
    deliveries,
    queued: useQueue,
  };
}

/** Deliver a single pending retry to one subscriber (or fallback target). */
export async function sendPushToSubscriber(
  env: Env,
  envelope: PushEnvelope,
  subscriberId: number | null,
  opts?: { fetchImpl?: typeof fetch },
): Promise<PushResult> {
  let target: ResolvedTarget | null = null;

  if (subscriberId != null) {
    const sub = await getSubscriber(env, subscriberId);
    if (!sub || !sub.enabled) {
      return {
        skipped: true,
        reason: sub ? "subscriber disabled" : "subscriber not found",
        http_status: null,
        success: false,
        retry_count: 0,
      };
    }
    target = { subscriber_id: sub.id, url: sub.url, secret: sub.secret };
  } else {
    const fallback = env.PUSH_TARGET_URL?.trim();
    if (!fallback) {
      return {
        skipped: true,
        reason: "PUSH_TARGET_URL not set",
        http_status: null,
        success: false,
        retry_count: 0,
      };
    }
    target = {
      subscriber_id: null,
      url: fallback,
      secret: env.PUSH_SECRET?.trim() || null,
    };
  }

  const delivery = await attemptDelivery(env, envelope, target, opts?.fetchImpl ?? fetch);

  return {
    skipped: !!delivery.skipped_circuit,
    reason: delivery.skipped_circuit ? delivery.error_message : undefined,
    http_status: delivery.http_status,
    success: delivery.success,
    error_message: delivery.error_message,
    retry_count: 0,
    deliveries: [delivery],
  };
}

/** Reload immutable envelope from push_events when event_id is present. */
async function resolveRetryEnvelope(
  env: Env,
  row: { event_id: string | null; payload_json: string },
): Promise<PushEnvelope> {
  if (row.event_id) {
    const fromLedger = await getPushEventById(env, row.event_id);
    if (fromLedger) return fromLedger;
  }
  return JSON.parse(row.payload_json) as PushEnvelope;
}

export async function flushDueRetries(
  env: Env,
  opts?: { fetchImpl?: typeof fetch; retryState?: RetryRunState },
): Promise<number> {
  const state = opts?.retryState ?? createRetryRunState(env);
  await giveUpStaleLegacyPending(env);

  if (state.sent >= state.max) return 0;

  const now = new Date().toISOString();
  const scanLimit = Math.max(state.max * RETRY_SCAN_MULTIPLIER, state.max);
  const { results } = await env.DB.prepare(
    `SELECT id, event_type, payload_json, retry_count, subscriber_id, event_id, last_error FROM pending_pushes
     WHERE next_retry_at IS NOT NULL AND next_retry_at <= ?
       AND IFNULL(last_error, '') != ?
     ORDER BY next_retry_at ASC LIMIT ?`,
  )
    .bind(now, GAVE_UP, scanLimit)
    .all<{
      id: number;
      event_type: string;
      payload_json: string;
      retry_count: number;
      subscriber_id: number | null;
      event_id: string | null;
      last_error: string | null;
    }>();

  let sentThisCall = 0;
  for (const row of results ?? []) {
    if (state.sent >= state.max) break;
    if (isGaveUp(row.last_error)) continue;

    const subKey = subscriberKey(row.subscriber_id ?? null);
    if (state.rateLimitedSubscribers.has(subKey)) {
      // Leave the row untouched for a later invocation.
      continue;
    }

    const envelope = await resolveRetryEnvelope(env, row);
    await env.DB.prepare(`DELETE FROM pending_pushes WHERE id = ?`).bind(row.id).run();
    const result = await sendPushToSubscriber(env, envelope, row.subscriber_id ?? null, {
      fetchImpl: opts?.fetchImpl,
    });
    state.sent++;
    sentThisCall++;

    if (result.http_status === 429) {
      state.rateLimitedSubscribers.add(subKey);
    }

    if (!result.success && !result.skipped) {
      await enqueueRetry(
        env,
        envelope,
        row.retry_count + 1,
        result.error_message ?? "retry failed",
        row.subscriber_id ?? null,
      );
    }
  }
  return sentThisCall;
}

/** Piggy-back: send any exhausted pending pushes alongside a successful new event. */
export async function piggybackPending(
  env: Env,
  opts?: { fetchImpl?: typeof fetch; retryState?: RetryRunState },
): Promise<number> {
  const state = opts?.retryState ?? createRetryRunState(env);
  await giveUpStaleLegacyPending(env);

  if (state.sent >= state.max) return 0;

  const scanLimit = Math.max(state.max * RETRY_SCAN_MULTIPLIER, state.max);
  const { results } = await env.DB.prepare(
    `SELECT id, payload_json, retry_count, subscriber_id, event_id, last_error FROM pending_pushes
     WHERE next_retry_at IS NULL
       AND IFNULL(last_error, '') != ?
     ORDER BY id ASC LIMIT ?`,
  )
    .bind(GAVE_UP, scanLimit)
    .all<{
      id: number;
      payload_json: string;
      retry_count: number;
      subscriber_id: number | null;
      event_id: string | null;
      last_error: string | null;
    }>();

  let sentThisCall = 0;
  for (const row of results ?? []) {
    if (state.sent >= state.max) break;
    if (isGaveUp(row.last_error)) continue;

    const subKey = subscriberKey(row.subscriber_id ?? null);
    if (state.rateLimitedSubscribers.has(subKey)) {
      continue;
    }

    const envelope = await resolveRetryEnvelope(env, row);
    await env.DB.prepare(`DELETE FROM pending_pushes WHERE id = ?`).bind(row.id).run();
    const result = await sendPushToSubscriber(env, envelope, row.subscriber_id ?? null, {
      fetchImpl: opts?.fetchImpl,
    });
    state.sent++;
    sentThisCall++;

    if (result.http_status === 429) {
      state.rateLimitedSubscribers.add(subKey);
    }

    if (!result.success && !result.skipped) {
      await env.DB.prepare(
        `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
        .bind(
          envelope.event,
          JSON.stringify(envelope),
          row.retry_count ?? 0,
          new Date().toISOString(),
          result.error_message ?? "piggyback failed",
          row.subscriber_id ?? null,
          ensureEventId(envelope).event_id || null,
        )
        .run();
    }
  }
  return sentThisCall;
}

export type { PushEvent, PushSubscriber };
