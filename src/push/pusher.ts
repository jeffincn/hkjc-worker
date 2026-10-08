import type { Env } from "../env";
import { envBool } from "../env";
import { contentHash } from "../parse/hash";
import type { PushEnvelope, PushEvent } from "./envelope";
import { isLivePushEvent } from "./envelope";
import {
  countSubscribers,
  getSubscriber,
  listEnabledSubscribers,
  type PushSubscriber,
} from "./subscribers";

const BACKOFF_MINUTES = [1, 5, 15];
const USER_AGENT = "hkjc-data-worker/1.0";

export interface PushResult {
  skipped: boolean;
  reason?: string;
  http_status: number | null;
  success: boolean;
  error_message?: string;
  retry_count: number;
  /** Per-subscriber delivery outcomes when fan-out ran. */
  deliveries?: SubscriberDelivery[];
}

export interface SubscriberDelivery {
  subscriber_id: number | null;
  url: string;
  http_status: number | null;
  success: boolean;
  error_message?: string;
  signed: boolean;
}

interface ResolvedTarget {
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

export async function sendPush(
  env: Env,
  envelope: PushEnvelope,
  opts?: { fetchImpl?: typeof fetch; force?: boolean },
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
    await logPush(env, envelope, {
      http_status: null,
      success: false,
      retry_count: 0,
      error_message: "no push subscribers and PUSH_TARGET_URL not set",
    });
    return {
      skipped: true,
      reason: "no push subscribers and PUSH_TARGET_URL not set",
      http_status: null,
      success: false,
      retry_count: 0,
    };
  }

  const body = JSON.stringify(envelope);
  const fetchImpl = opts?.fetchImpl ?? fetch;

  // Deliver independently — one failure must not block or drop the others.
  const deliveries = await Promise.all(
    targets.map((target) =>
      deliverToTarget(env, envelope, body, target, fetchImpl, { enqueueOnFailure: true }),
    ),
  );

  const anySuccess = deliveries.some((d) => d.success);
  const firstSuccess = deliveries.find((d) => d.success);
  const firstFailure = deliveries.find((d) => !d.success);

  return {
    skipped: false,
    http_status: firstSuccess?.http_status ?? firstFailure?.http_status ?? null,
    success: anySuccess,
    error_message: anySuccess
      ? undefined
      : firstFailure?.error_message ?? "all subscribers failed",
    retry_count: 0,
    deliveries,
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

  const body = JSON.stringify(envelope);
  // Caller (flush/piggyback) owns retry enqueue so backoff counts stay correct.
  const delivery = await deliverToTarget(
    env,
    envelope,
    body,
    target,
    opts?.fetchImpl ?? fetch,
    { enqueueOnFailure: false },
  );

  return {
    skipped: false,
    http_status: delivery.http_status,
    success: delivery.success,
    error_message: delivery.error_message,
    retry_count: 0,
    deliveries: [delivery],
  };
}

async function deliverToTarget(
  env: Env,
  envelope: PushEnvelope,
  body: string,
  target: ResolvedTarget,
  fetchImpl: typeof fetch,
  opts: { enqueueOnFailure: boolean },
): Promise<SubscriberDelivery> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  const signed = !!(target.secret && target.secret.length > 0);
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
    if (!success && opts.enqueueOnFailure) {
      await enqueueRetry(
        env,
        envelope,
        0,
        error_message ?? `HTTP ${res.status}`,
        target.subscriber_id,
      );
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
    if (opts.enqueueOnFailure) {
      await enqueueRetry(env, envelope, 0, msg, target.subscriber_id);
    }
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
  const hash = await contentHash(envelope);
  await env.DB.prepare(
    `INSERT INTO push_log (event_type, target_url, http_status, retry_count, success, payload_hash, error_message, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      envelope.event,
      info.target ?? null,
      info.http_status,
      info.retry_count,
      info.success ? 1 : 0,
      hash,
      info.error_message ?? null,
      envelope.sent_at,
    )
    .run();
}

export async function enqueueRetry(
  env: Env,
  envelope: PushEnvelope,
  retryCount: number,
  lastError: string,
  subscriberId: number | null = null,
): Promise<void> {
  if (retryCount >= BACKOFF_MINUTES.length) {
    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id)
       VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    )
      .bind(
        envelope.event,
        JSON.stringify(envelope),
        retryCount,
        envelope.sent_at,
        lastError,
        subscriberId,
      )
      .run();
    return;
  }
  const delayMin = BACKOFF_MINUTES[retryCount];
  const next = new Date(Date.now() + delayMin * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      envelope.event,
      JSON.stringify(envelope),
      retryCount,
      next,
      envelope.sent_at,
      lastError,
      subscriberId,
    )
    .run();
}

export function nextBackoffMinutes(retryCount: number): number | null {
  return BACKOFF_MINUTES[retryCount] ?? null;
}

export async function flushDueRetries(
  env: Env,
  opts?: { fetchImpl?: typeof fetch },
): Promise<number> {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, event_type, payload_json, retry_count, subscriber_id FROM pending_pushes
     WHERE next_retry_at IS NOT NULL AND next_retry_at <= ?
     ORDER BY next_retry_at ASC LIMIT 20`,
  )
    .bind(now)
    .all<{
      id: number;
      event_type: string;
      payload_json: string;
      retry_count: number;
      subscriber_id: number | null;
    }>();

  let sent = 0;
  for (const row of results ?? []) {
    const envelope = JSON.parse(row.payload_json) as PushEnvelope;
    await env.DB.prepare(`DELETE FROM pending_pushes WHERE id = ?`).bind(row.id).run();
    const result = await sendPushToSubscriber(env, envelope, row.subscriber_id ?? null, {
      fetchImpl: opts?.fetchImpl,
    });
    if (!result.success && !result.skipped) {
      await enqueueRetry(
        env,
        envelope,
        row.retry_count + 1,
        result.error_message ?? "retry failed",
        row.subscriber_id ?? null,
      );
    }
    sent++;
  }
  return sent;
}

/** Piggy-back: send any exhausted pending pushes alongside a successful new event. */
export async function piggybackPending(
  env: Env,
  opts?: { fetchImpl?: typeof fetch },
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, payload_json, retry_count, subscriber_id FROM pending_pushes
     WHERE next_retry_at IS NULL
     ORDER BY id ASC LIMIT 10`,
  ).all<{
    id: number;
    payload_json: string;
    retry_count: number;
    subscriber_id: number | null;
  }>();

  let sent = 0;
  for (const row of results ?? []) {
    const envelope = JSON.parse(row.payload_json) as PushEnvelope;
    await env.DB.prepare(`DELETE FROM pending_pushes WHERE id = ?`).bind(row.id).run();
    const result = await sendPushToSubscriber(env, envelope, row.subscriber_id ?? null, {
      fetchImpl: opts?.fetchImpl,
    });
    if (!result.success && !result.skipped) {
      await env.DB.prepare(
        `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id)
         VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      )
        .bind(
          envelope.event,
          JSON.stringify(envelope),
          row.retry_count,
          new Date().toISOString(),
          result.error_message ?? "piggyback failed",
          row.subscriber_id ?? null,
        )
        .run();
    }
    sent++;
  }
  return sent;
}

export type { PushEvent, PushSubscriber };
