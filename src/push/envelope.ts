export type PushEvent =
  | "test"
  | "schedule"
  | "odds_update"
  | "lock"
  | "scratch"
  | "result"
  | "backfill_progress"
  | "whitelist_alert"
  | "horse_update"
  | "injury_update"
  | "runs_update"
  | "dividends"
  | "changes";

export interface PushRunner {
  horse_no: number;
  horse_name: string | null;
  win_odds: number | null;
  place_odds: number | null;
  status: string | null;
  final_position: number | null;
}

export interface PushRace {
  race_no: number;
  post_time: string | null;
  snapshot_time: string;
  pool_status: string | null;
  runners: PushRunner[];
}

export interface PushEnvelope {
  schema: "hkjc-push/1.0";
  event: PushEvent;
  sent_at: string;
  meeting_date: string | null;
  venue: string | null;
  races: PushRace[];
  meta?: Record<string, unknown>;
}

export function buildEnvelope(args: {
  event: PushEvent;
  meeting_date?: string | null;
  venue?: string | null;
  races?: PushRace[];
  sent_at?: string;
  meta?: Record<string, unknown>;
}): PushEnvelope {
  return {
    schema: "hkjc-push/1.0",
    event: args.event,
    sent_at: args.sent_at ?? formatHkNow(),
    meeting_date: args.meeting_date ?? null,
    venue: args.venue ?? null,
    races: args.races ?? [],
    ...(args.meta ? { meta: args.meta } : {}),
  };
}

export function formatHkNow(date = new Date()): string {
  // Format as ISO with +08:00 offset for Asia/Hong_Kong
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+08:00`;
}

/** Live events gated by LIVE_PUSH_ENABLED (test / schedule / backfill_progress / whitelist_alert always allowed). */
export function isLivePushEvent(event: PushEvent): boolean {
  return (
    event === "odds_update" ||
    event === "lock" ||
    event === "scratch" ||
    event === "result" ||
    event === "horse_update" ||
    event === "injury_update" ||
    event === "runs_update" ||
    event === "dividends" ||
    event === "changes"
  );
}
