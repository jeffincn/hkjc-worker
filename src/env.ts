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
  /** Max HTTP deliveries per second per subscriber (default 2); excess delayed, never dropped. */
  PUSH_RATE_PER_SUB_PER_SEC?: string;
  /** Min active pending rows per subscriber before backlog coalesce (default 2). */
  PUSH_BACKLOG_COALESCE_MIN?: string;
  /** Max odds change rows per backlog_replay chunk (default 200). */
  PUSH_BACKLOG_MAX_CHANGES?: string;
  /**
   * Full odds_update at most this often per race (default 300).
   * Still emitted on first snapshot and pool_status change.
   */
  PUSH_FULL_SNAPSHOT_INTERVAL_SEC?: string;
  /** Coalesce same-meeting odds_delta batches within this many ms (default 2000). */
  PUSH_COALESCE_MS?: string;
  /**
   * Race-day high-freq keepalive (default 300). When a periodic full snapshot
   * is also due, emit one odds_update instead of no_update.
   */
  HEARTBEAT_INTERVAL_SEC?: string;
  /**
   * Keepalive outside the race-day high-freq window / non-race days
   * (default 1800). Always merged with a full odds_update snapshot.
   */
  OFFDAY_HEARTBEAT_INTERVAL_SEC?: string;
  /**
   * High-freq window opens this many seconds before the first race post time
   * (default 7200). Window ends when the final race's dividends are published.
   */
  RACEDAY_WINDOW_BEFORE_SEC?: string;
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
