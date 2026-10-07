export interface Env {
  DB: D1Database;
  MEETING_DO: DurableObjectNamespace;
  PUSH_TARGET_URL?: string;
  API_TOKEN?: string;
  PUSH_SECRET?: string;
  POLL_INTERVAL_SEC?: string;
  BACKFILL_DAYS?: string;
  TIMEZONE?: string;
  LIVE_PUSH_ENABLED?: string;
  BACKFILL_SOURCE?: string;
  /** Max horse HTML pages to fetch per refresh call (resumable). */
  HORSE_REFRESH_BATCH?: string;
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
