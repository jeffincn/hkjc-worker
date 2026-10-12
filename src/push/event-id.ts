import type { PushEnvelope } from "./envelope";

/**
 * When hkjc-push/1.1 landed on main (PR #10 merge window).
 * Rows created at/after this cutoff are never eligible for gave_up abandonment,
 * even if event_id were somehow empty (defense in depth).
 */
export const PUSH_1_1_DEPLOY_CUTOFF = "2026-10-10T00:00:00.000Z";

const SCHEMA_1_1 = "hkjc-push/1.1";

/** True when the envelope (or stored JSON) is post-1.1. */
export function isPushSchema11(envelopeOrJson: unknown): boolean {
  if (envelopeOrJson == null) return false;
  if (typeof envelopeOrJson === "string") {
    // Prefer structured parse; fall back to substring for malformed legacy blobs.
    try {
      const parsed = JSON.parse(envelopeOrJson) as { schema?: string };
      return parsed?.schema === SCHEMA_1_1;
    } catch {
      return (
        envelopeOrJson.includes(`"schema":"${SCHEMA_1_1}"`) ||
        envelopeOrJson.includes(`"schema": "${SCHEMA_1_1}"`)
      );
    }
  }
  if (typeof envelopeOrJson === "object" && envelopeOrJson !== null) {
    return (envelopeOrJson as { schema?: string }).schema === SCHEMA_1_1;
  }
  return false;
}

export function hasNonEmptyEventId(eventId: string | null | undefined): boolean {
  return typeof eventId === "string" && eventId.trim().length > 0;
}

/**
 * Every post-1.1 push must have a non-empty event_id before enqueue / pending_pushes.
 * Generates a UUID if somehow missing (should be rare — preparePushEvent always sets one).
 * Pre-1.1 / unknown-schema envelopes are left unchanged (may keep null event_id).
 */
export function ensureEventId(envelope: PushEnvelope): PushEnvelope {
  if (hasNonEmptyEventId(envelope.event_id)) {
    return envelope;
  }
  if (envelope.schema === SCHEMA_1_1 || isPushSchema11(envelope)) {
    return { ...envelope, event_id: crypto.randomUUID() };
  }
  return envelope;
}

/**
 * Assert non-empty event_id for any envelope about to be queued or pending-enqueued
 * as a 1.1 delivery. Throws if still empty after ensure (invariant violation).
 */
export function requireEventId(envelope: PushEnvelope): string {
  const ensured = ensureEventId(envelope);
  if (!hasNonEmptyEventId(ensured.event_id)) {
    throw new Error(
      `post-1.1 push missing event_id (event=${ensured.event} schema=${ensured.schema})`,
    );
  }
  // Mutate caller's object so downstream uses the same id.
  if (envelope.event_id !== ensured.event_id) {
    (envelope as { event_id: string }).event_id = ensured.event_id;
  }
  return ensured.event_id;
}

/**
 * Predicate for gave_up: ONLY pre-1.1 legacy rows.
 * A live race-day (post-1.1) push must never match.
 */
export function isLegacyGiveUpCandidate(row: {
  event_id: string | null | undefined;
  created_at: string;
  payload_json?: string | null;
}): boolean {
  if (hasNonEmptyEventId(row.event_id)) return false;
  if (row.created_at >= PUSH_1_1_DEPLOY_CUTOFF) return false;
  if (row.payload_json && isPushSchema11(row.payload_json)) return false;
  return true;
}
