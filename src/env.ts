export interface Env {
  DB: D1Database;
  MEETING_DO: DurableObjectNamespace;
  /** Optional: Cloudflare Queue for per-subscriber push delivery. */
  PUSH_QUEUE?: Queue;
  PUSH_TARGET_URL?: string;
  API_TOKEN?: string;
  PUSH_SECRET?: string;
  /** Live odds poll interval in ms while betting is open / race window (default 3000). */
  POLL_INTERVAL_MS?: string;
  /** @deprecated ignored by MeetingPoller; use POLL_INTERVAL_MS. */
  POLL_INTERVAL_SEC?: string;
  /** Max HKJC GraphQL HTTP requests per HKT day across pollers (default 30000). */
  DAILY_REQUEST_BUDGET?: string;
  BACKFILL_DAYS?: string;
  TIMEZONE?: string;
  LIVE_PUSH_ENABLED?: string;
  BACKFILL_SOURCE?: string;
  /** Max horse HTML pages to fetch per refresh call (resumable). */
  HORSE_REFRESH_BATCH?: string;
  /** Max pending_pushes HTTP sends per ingest/cron invocation (default 5). */
  PUSH_RETRY_MAX_PER_RUN?: string;
  /** Soft per-invocation subrequest budget (default 45). */
  SUBREQUEST_BUDGET?: string;
  /** Consecutive failures before circuit opens (default 10). */
  CIRCUIT_BREAKER_THRESHOLD?: string;
  /** Consecutive HTTP 429s before circuit opens (default 3). */
  CIRCUIT_BREAKER_429_THRESHOLD?: string;
  /** Ms after open before half-open probe (default 300000). */
  CIRCUIT_HALF_OPEN_MS?: string;
  /** Max queue delivery attempts before pending_pushes (default 5). */
  PUSH_QUEUE_MAX_ATTEMPTS?: string;
  /** Re-arm MeetingPoller when last tick older than this many ms (default 600000). */
  POLLER_STALE_MS?: string;
}

export function envNum(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(env: Env, key: keyof Env, fallback = false): boolean {
  const raw = env[key];
  if (typeof raw !== "string") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function envStr(env: Env, key: keyof Env, fallback: string): string {
  const raw = env[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : fallback;
}
