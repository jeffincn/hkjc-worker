import { GRAPHQL_ENDPOINT } from "../graphql/queries";

export type PushEvent =
  | "test"
  | "schedule"
  | "odds_update"
  | "odds_delta"
  | "no_update"
  | "lock"
  | "scratch"
  | "result"
  | "backfill_progress"
  | "whitelist_alert"
  | "source_blocked"
  | "source_recovered"
  | "horse_update"
  | "injury_update"
  | "runs_update"
  | "dividends"
  | "changes"
  /** Coalesced replay of a subscriber backlog (see docs/push-schema-1.1.md). */
  | "backlog_replay";

/** HKJC GraphQL WIN/PLA oddsValue is decimal: total return per $1 incl. stake. */
export const ODDS_BASIS =
  "HKD total return per $1 unit incl. stake" as const;

export interface PushRunner {
  /** Stable HKJC horse/runner identity — never cloth number alone. */
  runner_id?: string;
  horse_no: number;
  horse_name: string | null;
  /** Additive 1.1 field; omitted by older producers. */
  horse_name_ch?: string | null;
  win_odds: number | null;
  place_odds: number | null;
  /** Declared | Standby preferred; legacy may carry raw HKJC status. */
  status: string | null;
  final_position: number | null;
}

export interface PushRace {
  race_no: number;
  post_time: string | null;
  snapshot_time: string;
  pool_status: string | null;
  /** Per-race pmPools lastUpdateTime (or null when unknown). */
  source_last_updated_at?: string | null;
  /**
   * Per-race source timestamp, always Asia/Hong_Kong (`+08:00`) when known.
   * Same instant as source_last_updated_at when that value is already HK wall time.
   */
  source_ts?: string | null;
  runners: PushRunner[];
}

export interface PushSource {
  name: "HKJC GraphQL";
  url: string;
  /** Explicit null when unknown — never omit. */
  last_updated_at: string | null;
}

export interface PushQuality {
  missing_source_time: boolean;
  /** True when at least one race's post_time was already past at capture. */
  post_start: boolean;
  /** sent_at - captured_at in milliseconds. */
  late_ms: number;
  /**
   * Poll interval (seconds) actually in effect when this data was captured
   * (3/5/10/60…, after throttle/backoff). Explicit null for non-polled events.
   */
  sample_interval_s: number | null;
}

export type OddsBetType = "WIN" | "PLA";

export interface OddsDeltaChange {
  race_no: number;
  /** @deprecated Prefer horse_no; kept for 1.1 receivers (= cloth / standby number). */
  runner_no: number;
  /** Stable runner identity (HKJC horse code / id). */
  runner_id?: string;
  /** Cloth or standby number (not unique across Declared vs Standby). */
  horse_no?: number;
  horse_name_ch: string | null;
  horse_name_en: string | null;
  /** Convenience alias of horse_name_en for receivers. */
  horse_name?: string | null;
  /** Declared | Standby. */
  status?: string | null;
  bet_type: OddsBetType;
  /** Same as bet_type (WIN | PLA); explicit pool label for receivers. */
  pool?: OddsBetType;
  odds_basis: typeof ODDS_BASIS;
  prev_odds: number | null;
  new_odds: number | null;
  source_last_updated_at: string | null;
  race_post_time: string | null;
  pool_status: string | null;
  /**
   * Present on live-coalesced odds_delta (and backlog_replay): originating
   * observation time / seq / poll interval for this change row.
   */
  captured_at?: string;
  seq?: number;
  sample_interval_s?: number | null;
}

export interface OddsPoolInvestment {
  race_no: number;
  bet_type: OddsBetType;
  /**
   * Official HKJC WIN/PLA pool **cumulative** turnover (`raceMeetings.poolInvs.investment`),
   * currency HKD, whole pool (not per-horse, not a delta since last push). Null when the
   * odds whitelist query has no investment field.
   */
  investment: number | null;
}

export interface PushEnvelope {
  schema: "hkjc-push/1.1";
  event: PushEvent;
  event_id: string;
  /** Monotonic per meeting_date+venue (global key when meeting is null). */
  seq: number;
  captured_at: string;
  sent_at: string;
  meeting_date: string | null;
  venue: string | null;
  source: PushSource;
  quality: PushQuality;
  races: PushRace[];
  /**
   * odds_delta / backlog_replay payload.
   * On backlog_replay each change keeps its own prev/new odds and is annotated
   * with the originating event's `seq` + `captured_at` (see BacklogOddsChange).
   */
  changes?: OddsDeltaChange[];
  /** Per-race WIN/PLA pool turnover (never per-horse). */
  pools?: OddsPoolInvestment[];
  /** no_update: last odds-changing event for this meeting */
  last_change_seq?: number | null;
  last_change_at?: string | null;
  /**
   * Free-form metadata. For `backlog_replay`:
   * `covered_seq_from`, `covered_seq_to`, `coalesced_count`,
   * `coalesced_event_ids`, optional `chunk_index` / `chunk_total`, `reason`.
   */
  meta?: Record<string, unknown>;
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

export function parseHkMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

export function computeLateMs(capturedAt: string, sentAt: string): number {
  const a = parseHkMs(capturedAt);
  const b = parseHkMs(sentAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, b - a);
}

export function anyRacePastPost(
  races: Array<{ post_time?: string | null }>,
  capturedAtMs: number,
): boolean {
  for (const r of races) {
    if (!r.post_time) continue;
    const t = Date.parse(r.post_time);
    if (Number.isFinite(t) && t < capturedAtMs) return true;
  }
  return false;
}

export function buildSource(args?: {
  url?: string;
  last_updated_at?: string | null;
}): PushSource {
  return {
    name: "HKJC GraphQL",
    url: args?.url ?? GRAPHQL_ENDPOINT,
    last_updated_at:
      args?.last_updated_at === undefined ? null : args.last_updated_at,
  };
}

export function buildQuality(args: {
  source_last_updated_at: string | null;
  races: Array<{ post_time?: string | null }>;
  captured_at: string;
  sent_at: string;
  post_start?: boolean;
  sample_interval_s?: number | null;
}): PushQuality {
  const capturedMs = parseHkMs(args.captured_at);
  const post_start =
    args.post_start ??
    (Number.isFinite(capturedMs)
      ? anyRacePastPost(args.races, capturedMs)
      : false);
  return {
    missing_source_time: args.source_last_updated_at == null,
    post_start,
    late_ms: computeLateMs(args.captured_at, args.sent_at),
    sample_interval_s: normalizeSampleIntervalS(args.sample_interval_s),
  };
}

export function normalizeSampleIntervalS(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 1000) / 1000;
}

export interface BuildEnvelopeArgs {
  /** Effective poll interval (s) when captured; see PushQuality.sample_interval_s. */
  sample_interval_s?: number | null;
  event: PushEvent;
  meeting_date?: string | null;
  venue?: string | null;
  races?: PushRace[];
  captured_at?: string;
  sent_at?: string;
  event_id?: string;
  seq?: number;
  source_last_updated_at?: string | null;
  source_url?: string;
  post_start?: boolean;
  changes?: OddsDeltaChange[];
  pools?: OddsPoolInvestment[];
  last_change_seq?: number | null;
  last_change_at?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Assemble a hkjc-push/1.1 envelope.
 * Production callers should use preparePushEvent (allocates seq + ledger).
 * Unit tests may pass event_id/seq explicitly.
 */
export function buildEnvelope(args: BuildEnvelopeArgs): PushEnvelope {
  const captured_at = args.captured_at ?? formatHkNow();
  const sent_at = args.sent_at ?? formatHkNow();
  const races = args.races ?? [];
  const source_last_updated_at =
    args.source_last_updated_at === undefined
      ? null
      : args.source_last_updated_at;
  const source = buildSource({
    url: args.source_url,
    last_updated_at: source_last_updated_at,
  });
  const quality = buildQuality({
    source_last_updated_at,
    races,
    captured_at,
    sent_at,
    post_start: args.post_start,
    sample_interval_s: args.sample_interval_s,
  });

  const envelope: PushEnvelope = {
    schema: "hkjc-push/1.1",
    event: args.event,
    event_id: args.event_id ?? crypto.randomUUID(),
    seq: args.seq ?? 0,
    captured_at,
    sent_at,
    meeting_date: args.meeting_date ?? null,
    venue: args.venue ?? null,
    source,
    quality,
    races,
  };

  if (args.changes) envelope.changes = args.changes;
  if (args.pools) envelope.pools = args.pools;
  if (args.last_change_seq !== undefined) {
    envelope.last_change_seq = args.last_change_seq;
  }
  if (args.last_change_at !== undefined) {
    envelope.last_change_at = args.last_change_at;
  }
  if (args.meta) envelope.meta = args.meta;

  return envelope;
}

/** Live events gated by LIVE_PUSH_ENABLED (test / schedule / backfill_progress / whitelist_alert / source_blocked / source_recovered always allowed). */
export function isLivePushEvent(event: PushEvent): boolean {
  return (
    event === "odds_update" ||
    event === "odds_delta" ||
    event === "no_update" ||
    event === "lock" ||
    event === "scratch" ||
    event === "result" ||
    event === "horse_update" ||
    event === "injury_update" ||
    event === "runs_update" ||
    event === "dividends" ||
    event === "changes" ||
    event === "backlog_replay"
  );
}
