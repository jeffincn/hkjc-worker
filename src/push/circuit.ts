import type { Env } from "../env";
import { envNum } from "../env";

export type CircuitStateName = "closed" | "open" | "half_open";

export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 10;
/** Consecutive HTTP 429s that open the circuit (in addition to general failures). */
export const DEFAULT_CIRCUIT_429_THRESHOLD = 3;
export const DEFAULT_CIRCUIT_HALF_OPEN_MS = 5 * 60 * 1000;

const FALLBACK_META_PREFIX = "fallback_circuit_";

export interface CircuitSnapshot {
  subscriber_id: number | null;
  url: string | null;
  circuit_state: CircuitStateName;
  consecutive_failures: number;
  consecutive_429s: number;
  circuit_opened_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_http_status: number | null;
  last_error: string | null;
  /** Active pending_pushes rows for this subscriber (non-gave_up). */
  backlog_size?: number;
  /** Cumulative deliveries delayed by per-subscriber rate limit. */
  rate_limit_delays?: number;
}

export function circuitFailureThreshold(env: Env): number {
  return Math.max(1, envNum(env, "CIRCUIT_BREAKER_THRESHOLD", DEFAULT_CIRCUIT_FAILURE_THRESHOLD));
}

export function circuit429Threshold(env: Env): number {
  return Math.max(1, envNum(env, "CIRCUIT_BREAKER_429_THRESHOLD", DEFAULT_CIRCUIT_429_THRESHOLD));
}

export function circuitHalfOpenMs(env: Env): number {
  return Math.max(1000, envNum(env, "CIRCUIT_HALF_OPEN_MS", DEFAULT_CIRCUIT_HALF_OPEN_MS));
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseState(raw: string | null | undefined): CircuitStateName {
  if (raw === "open" || raw === "half_open" || raw === "closed") return raw;
  return "closed";
}

/**
 * Decide whether to attempt an HTTP delivery. May transition open → half_open
 * when the probe window has elapsed.
 */
export async function allowDeliveryAttempt(
  env: Env,
  subscriberId: number | null,
): Promise<{ allowed: boolean; reason?: string; state: CircuitStateName }> {
  const snap = await getCircuitSnapshot(env, subscriberId);
  if (snap.circuit_state === "closed") {
    return { allowed: true, state: "closed" };
  }
  if (snap.circuit_state === "half_open") {
    return { allowed: true, state: "half_open" };
  }

  // open: probe after half-open window
  const openedAt = snap.circuit_opened_at ? Date.parse(snap.circuit_opened_at) : NaN;
  const elapsed = Number.isFinite(openedAt) ? Date.now() - openedAt : Infinity;
  if (elapsed >= circuitHalfOpenMs(env)) {
    await setCircuitState(env, subscriberId, "half_open");
    return { allowed: true, state: "half_open" };
  }
  return {
    allowed: false,
    reason: "circuit_open",
    state: "open",
  };
}

export async function recordDeliverySuccess(
  env: Env,
  subscriberId: number | null,
  httpStatus: number | null,
): Promise<void> {
  const ts = nowIso();
  if (subscriberId == null) {
    await writeFallbackCircuit(env, {
      circuit_state: "closed",
      consecutive_failures: 0,
      consecutive_429s: 0,
      circuit_opened_at: null,
      last_success_at: ts,
      last_failure_at: null,
      last_http_status: httpStatus,
      last_error: null,
    });
    return;
  }
  await env.DB.prepare(
    `UPDATE push_subscribers SET
       consecutive_failures = 0,
       consecutive_429s = 0,
       circuit_state = 'closed',
       circuit_opened_at = NULL,
       last_success_at = ?,
       last_http_status = ?,
       last_error = NULL,
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(ts, httpStatus, ts, subscriberId)
    .run();
}

export async function recordDeliveryFailure(
  env: Env,
  subscriberId: number | null,
  info: { http_status: number | null; error_message?: string },
): Promise<CircuitStateName> {
  const ts = nowIso();
  const snap = await getCircuitSnapshot(env, subscriberId);
  const failures = snap.consecutive_failures + 1;
  const is429 = info.http_status === 429;
  const consecutive429s = is429 ? snap.consecutive_429s + 1 : 0;

  const failThresh = circuitFailureThreshold(env);
  const thresh429 = circuit429Threshold(env);
  const shouldOpen =
    failures >= failThresh || consecutive429s >= thresh429 || snap.circuit_state === "half_open";

  const nextState: CircuitStateName = shouldOpen ? "open" : snap.circuit_state === "half_open" ? "open" : "closed";
  const openedAt =
    nextState === "open"
      ? snap.circuit_state === "open" && snap.circuit_opened_at
        ? snap.circuit_opened_at
        : ts
      : null;

  if (subscriberId == null) {
    await writeFallbackCircuit(env, {
      circuit_state: nextState,
      consecutive_failures: failures,
      consecutive_429s: consecutive429s,
      circuit_opened_at: openedAt,
      last_success_at: snap.last_success_at,
      last_failure_at: ts,
      last_http_status: info.http_status,
      last_error: info.error_message ?? null,
    });
    return nextState;
  }

  await env.DB.prepare(
    `UPDATE push_subscribers SET
       consecutive_failures = ?,
       consecutive_429s = ?,
       circuit_state = ?,
       circuit_opened_at = ?,
       last_failure_at = ?,
       last_http_status = ?,
       last_error = ?,
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      failures,
      consecutive429s,
      nextState,
      openedAt,
      ts,
      info.http_status,
      info.error_message ?? null,
      ts,
      subscriberId,
    )
    .run();

  return nextState;
}

async function setCircuitState(
  env: Env,
  subscriberId: number | null,
  state: CircuitStateName,
): Promise<void> {
  const ts = nowIso();
  if (subscriberId == null) {
    const snap = await getFallbackCircuit(env);
    await writeFallbackCircuit(env, { ...snap, circuit_state: state });
    return;
  }
  await env.DB.prepare(
    `UPDATE push_subscribers SET circuit_state = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(state, ts, subscriberId)
    .run();
}

export async function getCircuitSnapshot(
  env: Env,
  subscriberId: number | null,
): Promise<CircuitSnapshot> {
  if (subscriberId == null) {
    const fb = await getFallbackCircuit(env);
    return {
      subscriber_id: null,
      url: env.PUSH_TARGET_URL?.trim() || null,
      ...fb,
    };
  }

  const row = await env.DB.prepare(
    `SELECT id, url, consecutive_failures, consecutive_429s, circuit_state,
            circuit_opened_at, last_success_at, last_failure_at, last_http_status, last_error
     FROM push_subscribers WHERE id = ?`,
  )
    .bind(subscriberId)
    .first<{
      id: number;
      url: string;
      consecutive_failures: number;
      consecutive_429s: number;
      circuit_state: string;
      circuit_opened_at: string | null;
      last_success_at: string | null;
      last_failure_at: string | null;
      last_http_status: number | null;
      last_error: string | null;
    }>();

  if (!row) {
    return {
      subscriber_id: subscriberId,
      url: null,
      circuit_state: "closed",
      consecutive_failures: 0,
      consecutive_429s: 0,
      circuit_opened_at: null,
      last_success_at: null,
      last_failure_at: null,
      last_http_status: null,
      last_error: null,
    };
  }

  return {
    subscriber_id: row.id,
    url: row.url,
    circuit_state: parseState(row.circuit_state),
    consecutive_failures: row.consecutive_failures ?? 0,
    consecutive_429s: row.consecutive_429s ?? 0,
    circuit_opened_at: row.circuit_opened_at,
    last_success_at: row.last_success_at,
    last_failure_at: row.last_failure_at,
    last_http_status: row.last_http_status,
    last_error: row.last_error,
  };
}

export async function listCircuitSnapshots(env: Env): Promise<CircuitSnapshot[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, url, consecutive_failures, consecutive_429s, circuit_state,
            circuit_opened_at, last_success_at, last_failure_at, last_http_status, last_error
     FROM push_subscribers ORDER BY id ASC`,
  ).all<{
    id: number;
    url: string;
    consecutive_failures: number;
    consecutive_429s: number;
    circuit_state: string;
    circuit_opened_at: string | null;
    last_success_at: string | null;
    last_failure_at: string | null;
    last_http_status: number | null;
    last_error: string | null;
  }>();

  const { getSubscriberBacklogSize } = await import("./coalesce");
  const { getRateLimitDelayCount } = await import("./rate-limit");

  const rows: CircuitSnapshot[] = [];
  for (const row of results ?? []) {
    rows.push({
      subscriber_id: row.id,
      url: row.url,
      circuit_state: parseState(row.circuit_state),
      consecutive_failures: row.consecutive_failures ?? 0,
      consecutive_429s: row.consecutive_429s ?? 0,
      circuit_opened_at: row.circuit_opened_at,
      last_success_at: row.last_success_at,
      last_failure_at: row.last_failure_at,
      last_http_status: row.last_http_status,
      last_error: row.last_error,
      backlog_size: await getSubscriberBacklogSize(env, row.id),
      rate_limit_delays: await getRateLimitDelayCount(env, row.id),
    });
  }

  // Include fallback target health when no subscriber rows exist.
  if (rows.length === 0 && env.PUSH_TARGET_URL?.trim()) {
    const snap = await getCircuitSnapshot(env, null);
    snap.backlog_size = await getSubscriberBacklogSize(env, null);
    snap.rate_limit_delays = await getRateLimitDelayCount(env, null);
    rows.push(snap);
  }
  return rows;
}

interface FallbackCircuitFields {
  circuit_state: CircuitStateName;
  consecutive_failures: number;
  consecutive_429s: number;
  circuit_opened_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_http_status: number | null;
  last_error: string | null;
}

async function getFallbackCircuit(env: Env): Promise<FallbackCircuitFields> {
  const get = async (key: string) => {
    const row = await env.DB.prepare(`SELECT value FROM worker_meta WHERE key=?`)
      .bind(FALLBACK_META_PREFIX + key)
      .first<{ value: string }>();
    return row?.value ?? null;
  };
  const statusRaw = await get("last_http_status");
  const statusNum = statusRaw != null && statusRaw !== "" ? Number(statusRaw) : NaN;
  return {
    circuit_state: parseState(await get("state")),
    consecutive_failures: Number(await get("failures")) || 0,
    consecutive_429s: Number(await get("429s")) || 0,
    circuit_opened_at: await get("opened_at"),
    last_success_at: await get("last_success_at"),
    last_failure_at: await get("last_failure_at"),
    last_http_status: Number.isFinite(statusNum) ? statusNum : null,
    last_error: await get("last_error"),
  };
}

async function writeFallbackCircuit(env: Env, fields: FallbackCircuitFields): Promise<void> {
  const put = async (key: string, value: string | null) => {
    const ts = nowIso();
    await env.DB.prepare(
      `INSERT INTO worker_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    )
      .bind(FALLBACK_META_PREFIX + key, value ?? "", ts)
      .run();
  };
  await put("state", fields.circuit_state);
  await put("failures", String(fields.consecutive_failures));
  await put("429s", String(fields.consecutive_429s));
  await put("opened_at", fields.circuit_opened_at);
  await put("last_success_at", fields.last_success_at);
  await put("last_failure_at", fields.last_failure_at);
  await put(
    "last_http_status",
    fields.last_http_status == null ? null : String(fields.last_http_status),
  );
  await put("last_error", fields.last_error);
}
