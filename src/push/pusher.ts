import type { Env } from "../env";
import { envBool } from "../env";
import { contentHash } from "../parse/hash";
import type { PushEnvelope, PushEvent } from "./envelope";
import { isLivePushEvent } from "./envelope";

const BACKOFF_MINUTES = [1, 5, 15];

export interface PushResult {
  skipped: boolean;
  reason?: string;
  http_status: number | null;
  success: boolean;
  error_message?: string;
  retry_count: number;
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

  const target = env.PUSH_TARGET_URL?.trim();
  if (!target) {
    await logPush(env, envelope, {
      http_status: null,
      success: false,
      retry_count: 0,
      error_message: "PUSH_TARGET_URL not set",
    });
    return {
      skipped: true,
      reason: "PUSH_TARGET_URL not set",
      http_status: null,
      success: false,
      retry_count: 0,
    };
  }

  const body = JSON.stringify(envelope);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.PUSH_SECRET) {
    headers["X-Signature"] = await hmacSha256Hex(env.PUSH_SECRET, body);
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(target, { method: "POST", headers, body });
    const success = res.status === 202 || res.ok;
    await logPush(env, envelope, {
      http_status: res.status,
      success,
      retry_count: 0,
      error_message: success ? undefined : `HTTP ${res.status}`,
      target,
    });
    if (!success) {
      await enqueueRetry(env, envelope, 0, `HTTP ${res.status}`);
    }
    return {
      skipped: false,
      http_status: res.status,
      success,
      error_message: success ? undefined : `HTTP ${res.status}`,
      retry_count: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logPush(env, envelope, {
      http_status: null,
      success: false,
      retry_count: 0,
      error_message: msg,
      target,
    });
    await enqueueRetry(env, envelope, 0, msg);
    return {
      skipped: false,
      http_status: null,
      success: false,
      error_message: msg,
      retry_count: 0,
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
      info.target ?? env.PUSH_TARGET_URL ?? null,
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
): Promise<void> {
  if (retryCount >= BACKOFF_MINUTES.length) {
    // Exhausted scheduled retries — leave for piggy-back on next event
    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
      .bind(envelope.event, JSON.stringify(envelope), retryCount, envelope.sent_at, lastError)
      .run();
    return;
  }
  const delayMin = BACKOFF_MINUTES[retryCount];
  const next = new Date(Date.now() + delayMin * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(envelope.event, JSON.stringify(envelope), retryCount, next, envelope.sent_at, lastError)
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
    `SELECT id, event_type, payload_json, retry_count FROM pending_pushes
     WHERE next_retry_at IS NOT NULL AND next_retry_at <= ?
     ORDER BY next_retry_at ASC LIMIT 20`,
  )
    .bind(now)
    .all<{ id: number; event_type: string; payload_json: string; retry_count: number }>();

  let sent = 0;
  for (const row of results ?? []) {
    const envelope = JSON.parse(row.payload_json) as PushEnvelope;
    await env.DB.prepare(`DELETE FROM pending_pushes WHERE id = ?`).bind(row.id).run();
    const result = await sendPush(env, envelope, { fetchImpl: opts?.fetchImpl, force: true });
    if (!result.success && !result.skipped) {
      await enqueueRetry(env, envelope, row.retry_count + 1, result.error_message ?? "retry failed");
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
    `SELECT id, payload_json, retry_count FROM pending_pushes
     WHERE next_retry_at IS NULL
     ORDER BY id ASC LIMIT 10`,
  ).all<{ id: number; payload_json: string; retry_count: number }>();

  let sent = 0;
  for (const row of results ?? []) {
    const envelope = JSON.parse(row.payload_json) as PushEnvelope;
    await env.DB.prepare(`DELETE FROM pending_pushes WHERE id = ?`).bind(row.id).run();
    const result = await sendPush(env, envelope, { fetchImpl: opts?.fetchImpl, force: true });
    if (!result.success && !result.skipped) {
      // Re-queue without further scheduled backoff
      await env.DB.prepare(
        `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      )
        .bind(
          envelope.event,
          JSON.stringify(envelope),
          row.retry_count,
          new Date().toISOString(),
          result.error_message ?? "piggyback failed",
        )
        .run();
    }
    sent++;
  }
  return sent;
}

export type { PushEvent };
