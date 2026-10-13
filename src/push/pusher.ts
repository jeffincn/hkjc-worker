import type { Env } from "../env";
import { envBool, envNum } from "../env";
import { trackD1Result } from "../store/d1-budget";
import { d1Bind } from "../util/d1";
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
  backlogCoalesceMin,
  buildCoalescedDeliveries,
  shouldCoalesceBacklog,
  type PendingPushRow,
} from "./coalesce";
import { reserveDeliverySlot } from "./rate-limit";
import {
  countSubscribers,
  getSubscriber,
  listEnabledSubscribers,
  type PushSubscriber,
} from "./subscribers";
import {
  gateSubscriberDelivery,
  maybeDeliverWindowOpenSnapshot,
} from "./subscriber-window";

/** pending_pushes INSERT with undefined→null binds + write tracking. */
async function insertPendingPushRow(
  env: Env,
  args: {
    event_type: string;
    payload_json: string;
    retry_count: number;
    next_retry_at: string | null;
    created_at: string;
    last_error: string | null;
    subscriber_id: number | null;
    event_id: string | null;
  },
): Promise<void> {
  const result = await d1Bind(
    env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    args.event_type,
    args.payload_json,
    args.retry_count,
    args.next_retry_at,
    args.created_at,
    args.last_error,
    args.subscriber_id,
    args.event_id,
  ).run();
  await trackD1Result(env, result);
}

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
  let sub: PushSubscriber | null = null;

  if (subscriberId != null) {
    sub = await getSubscriber(env, subscriberId);
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

  const windowGate = await gateSubscriberDelivery(env, sub, envelope);
  if (!windowGate.allowed) {
    return {
      skipped: true,
      reason: windowGate.reason ?? "outside active window",
      http_status: null,
      success: false,
      retry_count: 0,
      deliveries: [
        {
          subscriber_id: target.subscriber_id,
          url: target.url,
          http_status: null,
          success: true,
          signed: !!(target.secret && target.secret.length > 0),
          skipped_window: true,
          error_message: windowGate.reason,
        },
      ],
    };
  }

  if (
    sub &&
    sub.active_window === "raceday" &&
    envelope.meeting_date &&
    envelope.venue
  ) {
    await maybeDeliverWindowOpenSnapshot({
      env,
      subscriber: sub,
      target,
      meeting_date: envelope.meeting_date,
      venue: envelope.venue,
      context: windowGate.context,
      fetchImpl: opts?.fetchImpl,
    });
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

async function deletePendingRows(env: Env, ids: number[]): Promise<void> {
  for (const id of ids) {
    await env.DB.prepare(`DELETE FROM pending_pushes WHERE id = ?`).bind(id).run();
  }
}

/** Rate-limited send used by flush/piggyback after rows are deleted. */
async function sendOrDeferPending(
  env: Env,
  envelope: PushEnvelope,
  subscriberId: number | null,
  retryCount: number,
  opts: {
    fetchImpl?: typeof fetch;
    /** When true, failed re-insert uses next_retry_at NULL (piggyback). */
    exhausted?: boolean;
  },
): Promise<{
  counted: boolean;
  http_status: number | null;
  success: boolean;
  skipped: boolean;
  error_message?: string;
  deferred_rate_limit: boolean;
}> {
  const slot = await reserveDeliverySlot(env, subscriberId);
  if (slot.delaySeconds > 0) {
    const next = new Date(Date.now() + slot.delaySeconds * 1000).toISOString();
    const ensured = ensureEventId(envelope);
    await insertPendingPushRow(env, {
      event_type: ensured.event ?? "unknown",
      payload_json: JSON.stringify(ensured),
      retry_count: retryCount,
      next_retry_at: next,
      created_at: new Date().toISOString(),
      last_error: `rate_limit_delay_${slot.delaySeconds}s`,
      subscriber_id: subscriberId,
      event_id: ensured.event_id || null,
    });
    return {
      counted: false,
      http_status: null,
      success: false,
      skipped: true,
      deferred_rate_limit: true,
    };
  }

  const result = await sendPushToSubscriber(env, envelope, subscriberId, {
    fetchImpl: opts.fetchImpl,
  });
  return {
    counted: true,
    http_status: result.http_status,
    success: result.success,
    skipped: !!result.skipped,
    error_message: result.error_message,
    deferred_rate_limit: false,
  };
}

function groupRowsBySubscriber(
  rows: PendingPushRow[],
): Map<string, PendingPushRow[]> {
  const map = new Map<string, PendingPushRow[]>();
  for (const row of rows) {
    if (isGaveUp(row.last_error)) continue;
    const key = subscriberKey(row.subscriber_id ?? null);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

/**
 * Flush due pending rows for one subscriber: coalesce when backlog is large,
 * otherwise replay one-by-one. Rate-limit delays defer (never drop).
 */
async function flushSubscriberPending(
  env: Env,
  rows: PendingPushRow[],
  state: RetryRunState,
  opts: { fetchImpl?: typeof fetch; exhausted?: boolean },
): Promise<number> {
  if (rows.length === 0) return 0;
  const subscriberId = rows[0]!.subscriber_id ?? null;
  const subKey = subscriberKey(subscriberId);
  let sentThisCall = 0;

  const coalesce = shouldCoalesceBacklog(rows.length, backlogCoalesceMin(env));

  if (coalesce) {
    const deliveries = await buildCoalescedDeliveries(env, rows);
    // If the subscriber is outside its raceday window, leave rows untouched.
    if (deliveries.length > 0) {
      const sub =
        subscriberId != null ? await getSubscriber(env, subscriberId) : null;
      const gate = await gateSubscriberDelivery(
        env,
        sub,
        deliveries[0]!.envelope,
      );
      if (!gate.allowed) return 0;
    }
    const allIds = [...new Set(deliveries.flatMap((d) => d.source_row_ids))];
    await deletePendingRows(env, allIds);

    for (const delivery of deliveries) {
      if (state.sent >= state.max) {
        // Budget exhausted: park remaining coalesced envelopes as pending.
        await insertPendingPushRow(env, {
          event_type: delivery.envelope.event ?? "unknown",
          payload_json: JSON.stringify(delivery.envelope),
          retry_count: delivery.retry_count,
          next_retry_at: opts.exhausted ? null : new Date().toISOString(),
          created_at: new Date().toISOString(),
          last_error: "deferred_budget",
          subscriber_id: subscriberId,
          event_id: delivery.envelope.event_id ?? null,
        });
        continue;
      }
      if (state.rateLimitedSubscribers.has(subKey)) {
        await insertPendingPushRow(env, {
          event_type: delivery.envelope.event ?? "unknown",
          payload_json: JSON.stringify(delivery.envelope),
          retry_count: delivery.retry_count,
          next_retry_at: opts.exhausted ? null : new Date().toISOString(),
          created_at: new Date().toISOString(),
          last_error: "deferred_429_sibling",
          subscriber_id: subscriberId,
          event_id: delivery.envelope.event_id ?? null,
        });
        continue;
      }

      const outcome = await sendOrDeferPending(
        env,
        delivery.envelope,
        subscriberId,
        delivery.retry_count,
        opts,
      );
      if (outcome.deferred_rate_limit) continue;
      if (!outcome.counted) continue;

      state.sent++;
      sentThisCall++;
      if (outcome.http_status === 429) {
        state.rateLimitedSubscribers.add(subKey);
      }
      if (!outcome.success && !outcome.skipped) {
        if (opts.exhausted) {
          await insertPendingPushRow(env, {
            event_type: delivery.envelope.event ?? "unknown",
            payload_json: JSON.stringify(delivery.envelope),
            retry_count: delivery.retry_count,
            next_retry_at: null,
            created_at: new Date().toISOString(),
            last_error: outcome.error_message ?? "piggyback failed",
            subscriber_id: subscriberId,
            event_id: delivery.envelope.event_id ?? null,
          });
        } else {
          await enqueueRetry(
            env,
            delivery.envelope,
            delivery.retry_count + 1,
            outcome.error_message ?? "retry failed",
            subscriberId,
          );
        }
      }
    }
    return sentThisCall;
  }

  // One-by-one path (small backlog).
  for (const row of rows) {
    if (state.sent >= state.max) break;
    if (state.rateLimitedSubscribers.has(subKey)) break;

    const envelope = await resolveRetryEnvelope(env, row);
    const sub =
      subscriberId != null ? await getSubscriber(env, subscriberId) : null;
    const gate = await gateSubscriberDelivery(env, sub, envelope);
    if (!gate.allowed) {
      // Leave row for a later in-window flush (do not delete / do not retry-bump).
      continue;
    }
    await deletePendingRows(env, [row.id]);
    const outcome = await sendOrDeferPending(
      env,
      envelope,
      subscriberId,
      row.retry_count ?? 0,
      opts,
    );
    if (outcome.deferred_rate_limit) continue;
    if (!outcome.counted) continue;

    state.sent++;
    sentThisCall++;
    if (outcome.http_status === 429) {
      state.rateLimitedSubscribers.add(subKey);
    }
    if (!outcome.success && !outcome.skipped) {
      if (opts.exhausted) {
        const ensured = ensureEventId(envelope);
        await insertPendingPushRow(env, {
          event_type: ensured.event ?? "unknown",
          payload_json: JSON.stringify(ensured),
          retry_count: row.retry_count ?? 0,
          next_retry_at: null,
          created_at: new Date().toISOString(),
          last_error: outcome.error_message ?? "piggyback failed",
          subscriber_id: subscriberId,
          event_id: ensured.event_id || null,
        });
      } else {
        await enqueueRetry(
          env,
          envelope,
          row.retry_count + 1,
          outcome.error_message ?? "retry failed",
          subscriberId,
        );
      }
    }
  }
  return sentThisCall;
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
    .all<PendingPushRow>();

  const bySub = groupRowsBySubscriber(results ?? []);
  let sentThisCall = 0;
  for (const rows of bySub.values()) {
    if (state.sent >= state.max) break;
    const subKey = subscriberKey(rows[0]!.subscriber_id ?? null);
    if (state.rateLimitedSubscribers.has(subKey)) continue;
    sentThisCall += await flushSubscriberPending(env, rows, state, {
      fetchImpl: opts?.fetchImpl,
      exhausted: false,
    });
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
    `SELECT id, event_type, payload_json, retry_count, subscriber_id, event_id, last_error FROM pending_pushes
     WHERE next_retry_at IS NULL
       AND IFNULL(last_error, '') != ?
     ORDER BY id ASC LIMIT ?`,
  )
    .bind(GAVE_UP, scanLimit)
    .all<PendingPushRow>();

  const bySub = groupRowsBySubscriber(results ?? []);
  let sentThisCall = 0;
  for (const rows of bySub.values()) {
    if (state.sent >= state.max) break;
    const subKey = subscriberKey(rows[0]!.subscriber_id ?? null);
    if (state.rateLimitedSubscribers.has(subKey)) continue;
    sentThisCall += await flushSubscriberPending(env, rows, state, {
      fetchImpl: opts?.fetchImpl,
      exhausted: true,
    });
  }
  return sentThisCall;
}

export type { PushEvent, PushSubscriber };
