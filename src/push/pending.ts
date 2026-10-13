import type { Env } from "../env";
import { d1Bind } from "../util/d1";
import { trackD1Result } from "../store/d1-budget";
import type { PushEnvelope } from "./envelope";
import { ensureEventId, hasNonEmptyEventId, isPushSchema11 } from "./event-id";

const BACKOFF_MINUTES = [1, 5, 15];

/** last_error marker for permanently abandoned rows (row kept, never deleted). */
export const GAVE_UP = "gave_up";

export function nextBackoffMinutes(retryCount: number): number | null {
  return BACKOFF_MINUTES[retryCount] ?? null;
}

/**
 * Enqueue a failed delivery for later retry.
 * Post-1.1 envelopes always get a non-empty event_id before insert
 * (generate if somehow missing) — never bind undefined / empty for 1.1 rows.
 */
export async function enqueueRetry(
  env: Env,
  envelope: PushEnvelope,
  retryCount: number,
  lastError: string | null | undefined,
  subscriberId: number | null = null,
): Promise<void> {
  const ensured = ensureEventId(envelope);
  // Invariant: hkjc-push/1.1 must never land in pending_pushes without event_id.
  if (isPushSchema11(ensured) && !hasNonEmptyEventId(ensured.event_id)) {
    throw new Error("invariant: 1.1 envelope missing event_id before pending_pushes");
  }
  const eventId = hasNonEmptyEventId(ensured.event_id) ? ensured.event_id : null;
  const eventType = ensured.event ?? "unknown";
  const createdAt = ensured.sent_at ?? new Date().toISOString();
  const err = lastError ?? null;
  const sub = subscriberId ?? null;

  if (retryCount >= BACKOFF_MINUTES.length) {
    const result = await d1Bind(
      env.DB.prepare(
        `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      ),
      eventType,
      JSON.stringify(ensured),
      retryCount,
      createdAt,
      err,
      sub,
      eventId,
    ).run();
    await trackD1Result(env, result);
    return;
  }
  const delayMin = BACKOFF_MINUTES[retryCount] ?? 15;
  const next = new Date(Date.now() + delayMin * 60_000).toISOString();
  const result = await d1Bind(
    env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    eventType,
    JSON.stringify(ensured),
    retryCount,
    next,
    createdAt,
    err,
    sub,
    eventId,
  ).run();
  await trackD1Result(env, result);
}
