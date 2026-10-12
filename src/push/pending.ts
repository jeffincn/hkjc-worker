import type { Env } from "../env";
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
  lastError: string,
  subscriberId: number | null = null,
): Promise<void> {
  const ensured = ensureEventId(envelope);
  // Invariant: hkjc-push/1.1 must never land in pending_pushes without event_id.
  if (isPushSchema11(ensured) && !hasNonEmptyEventId(ensured.event_id)) {
    throw new Error("invariant: 1.1 envelope missing event_id before pending_pushes");
  }
  const eventId = hasNonEmptyEventId(ensured.event_id) ? ensured.event_id : null;

  if (retryCount >= BACKOFF_MINUTES.length) {
    await env.DB.prepare(
      `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
      .bind(
        ensured.event,
        JSON.stringify(ensured),
        retryCount,
        ensured.sent_at ?? new Date().toISOString(),
        lastError ?? null,
        subscriberId ?? null,
        eventId,
      )
      .run();
    return;
  }
  const delayMin = BACKOFF_MINUTES[retryCount];
  const next = new Date(Date.now() + delayMin * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO pending_pushes (event_type, payload_json, retry_count, next_retry_at, created_at, last_error, subscriber_id, event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ensured.event,
      JSON.stringify(ensured),
      retryCount,
      next,
      ensured.sent_at ?? new Date().toISOString(),
      lastError ?? null,
      subscriberId ?? null,
      eventId,
    )
    .run();
}
