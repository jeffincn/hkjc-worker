import type { Env } from "../env";
import { allowD1Write, trackD1Result } from "../store/d1-budget";
import { setMeta } from "../store/db";
import { d1Bind } from "../util/d1";
import {
  allowDeliveryAttempt,
  recordDeliveryFailure,
  recordDeliverySuccess,
} from "./circuit";
import {
  isDuplicateBodyForSubscriber,
  pushBodyContentHash,
  rememberBodyHashForSubscriber,
} from "./dedupe";
import type { PushEnvelope } from "./envelope";
import { formatHkNow } from "./envelope";
import { getPushEventById } from "./ledger";
import { getSubscriber } from "./subscribers";

const USER_AGENT = "hkjc-data-worker/1.0";

export interface SubscriberDelivery {
  subscriber_id: number | null;
  url: string;
  http_status: number | null;
  success: boolean;
  error_message?: string;
  signed: boolean;
  /** True when delivery was enqueued to PUSH_QUEUE (not yet HTTP-posted). */
  queued?: boolean;
  /** True when skipped because circuit breaker is open. */
  skipped_circuit?: boolean;
  /** True when deferred due to per-subscriber rate limit (not dropped). */
  deferred_rate_limit?: boolean;
  /** Seconds the delivery was delayed for rate limiting. */
  rate_limit_delay_seconds?: number;
  /** True when skipped: identical stable body already delivered to this sub. */
  skipped_dedupe?: boolean;
  /** True when skipped: subscriber raceday window closed / not applicable. */
  skipped_window?: boolean;
}

export interface ResolvedTarget {
  subscriber_id: number | null;
  url: string;
  secret: string | null;
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve envelope (prefer ledger) and POST to one target.
 * Updates circuit breaker + last_push_* meta on outcome.
 * Skips HTTP when the stable body hash matches the last delivery to this sub.
 */
export async function deliverToTarget(
  env: Env,
  envelope: PushEnvelope,
  body: string,
  target: ResolvedTarget,
  fetchImpl: typeof fetch,
): Promise<SubscriberDelivery> {
  const signed = !!(target.secret && target.secret.length > 0);
  const bodyHash = await pushBodyContentHash(envelope);
  if (
    await isDuplicateBodyForSubscriber(
      env,
      target.subscriber_id,
      envelope.event,
      bodyHash,
    )
  ) {
    return {
      subscriber_id: target.subscriber_id,
      url: target.url,
      http_status: null,
      success: true,
      signed,
      skipped_dedupe: true,
      error_message: "skipped: duplicate body hash",
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (signed && target.secret) {
    headers["X-Signature"] = await hmacSha256Hex(target.secret, body);
  }

  try {
    const res = await fetchImpl(target.url, { method: "POST", headers, body });
    const success = res.status === 202 || res.ok;
    const error_message = success ? undefined : `HTTP ${res.status}`;
    await logPush(env, envelope, {
      http_status: res.status,
      success,
      retry_count: 0,
      error_message,
      target: target.url,
    });
    if (success) {
      await rememberBodyHashForSubscriber(
        env,
        target.subscriber_id,
        envelope.event,
        bodyHash,
      );
      await recordDeliverySuccess(env, target.subscriber_id, res.status);
      await markLastPush(env, res.status);
    } else {
      await recordDeliveryFailure(env, target.subscriber_id, {
        http_status: res.status,
        error_message,
      });
    }
    return {
      subscriber_id: target.subscriber_id,
      url: target.url,
      http_status: res.status,
      success,
      error_message,
      signed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logPush(env, envelope, {
      http_status: null,
      success: false,
      retry_count: 0,
      error_message: msg,
      target: target.url,
    });
    await recordDeliveryFailure(env, target.subscriber_id, {
      http_status: null,
      error_message: msg,
    });
    return {
      subscriber_id: target.subscriber_id,
      url: target.url,
      http_status: null,
      success: false,
      error_message: msg,
      signed,
    };
  }
}

/** Load from ledger by event_id then deliver to a resolved target. */
export async function deliverOne(
  env: Env,
  eventId: string,
  target: ResolvedTarget,
  fetchImpl: typeof fetch,
): Promise<SubscriberDelivery> {
  const envelope = await getPushEventById(env, eventId);
  if (!envelope) {
    return {
      subscriber_id: target.subscriber_id,
      url: target.url,
      http_status: null,
      success: false,
      error_message: `event_id ${eventId} not found in push_events`,
      signed: !!(target.secret && target.secret.length > 0),
    };
  }
  const body = JSON.stringify(envelope);
  return deliverToTarget(env, envelope, body, target, fetchImpl);
}

export async function resolveTargetBySubscriberId(
  env: Env,
  subscriberId: number | null,
): Promise<ResolvedTarget | null> {
  if (subscriberId != null) {
    const sub = await getSubscriber(env, subscriberId);
    if (!sub || !sub.enabled) return null;
    return { subscriber_id: sub.id, url: sub.url, secret: sub.secret };
  }
  const fallback = env.PUSH_TARGET_URL?.trim();
  if (!fallback) return null;
  return {
    subscriber_id: null,
    url: fallback,
    secret: env.PUSH_SECRET?.trim() || null,
  };
}

/** Gate + deliver; returns null when circuit skips. */
export async function attemptDelivery(
  env: Env,
  envelope: PushEnvelope,
  target: ResolvedTarget,
  fetchImpl: typeof fetch,
): Promise<SubscriberDelivery> {
  const gate = await allowDeliveryAttempt(env, target.subscriber_id);
  if (!gate.allowed) {
    return {
      subscriber_id: target.subscriber_id,
      url: target.url,
      http_status: null,
      success: false,
      error_message: `skipped: circuit ${gate.state}`,
      signed: !!(target.secret && target.secret.length > 0),
      skipped_circuit: true,
    };
  }
  const body = JSON.stringify(envelope);
  return deliverToTarget(env, envelope, body, target, fetchImpl);
}

async function logPush(
  env: Env,
  envelope: PushEnvelope,
  info: {
    http_status: number | null;
    success: boolean;
    retry_count: number;
    error_message?: string;
    target?: string;
  },
): Promise<void> {
  // Verbose push_log is non-essential — skip when D1 write budget is degraded.
  if (!(await allowD1Write(env, "push_log"))) return;
  // Stable body hash (timestamps/seq stripped) so dry-run scripts can dedupe.
  const hash = await pushBodyContentHash(envelope);
  const result = await d1Bind(
    env.DB.prepare(
      `INSERT INTO push_log (event_type, target_url, http_status, retry_count, success, payload_hash, error_message, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    envelope.event,
    info.target ?? null,
    info.http_status ?? null,
    info.retry_count ?? 0,
    info.success ? 1 : 0,
    hash,
    info.error_message ?? null,
    formatHkNow(),
  ).run();
  await trackD1Result(env, result);
}

/** Reflect newest push of any type (not only odds_update). */
export async function markLastPush(env: Env, httpStatus: number | null): Promise<void> {
  await setMeta(env.DB, "last_push_at", new Date().toISOString());
  await setMeta(env.DB, "last_push_status", httpStatus == null ? "null" : String(httpStatus));
}
