/**
 * Poll presence ticks for odds coverage (issue #26).
 *
 * odds_snapshots skip writes when content hash is unchanged, so a quiet
 * stretch looks identical to a polling outage. poll_ticks records each poll
 * per race, compacted to one row per UTC minute.
 */
import type { Env } from "../env";
import { allowD1Write, trackD1Result } from "./d1-budget";

/** Gaps longer than this are treated as collection failure. */
export const POLL_GAP_THRESHOLD_MS = 10 * 60 * 1000;

export interface PollTickInput {
  race_no: number;
  /** True when this poll inserted a new odds_snapshots row. */
  changed: boolean;
  /** ISO timestamp of the poll (defaults to now). */
  tick_at?: string;
}

export interface PollTickRow {
  meeting_date: string;
  venue: string;
  race_no: number;
  tick_minute: string;
  changed: number;
  last_tick_at: string;
  tick_count: number;
}

export interface PollGap {
  race_no: number;
  from: string;
  to: string;
  gap_ms: number;
}

export interface CoverageInterval {
  from: string;
  to: string;
  /** static = ticks present, no snapshot change; missing = no ticks (outage). */
  kind: "static" | "missing" | "changed";
  gap_ms: number;
  race_no?: number;
}

/** Truncate an ISO timestamp to the UTC minute bucket used as PK. */
export function tickMinuteBucket(isoOrMs: string | number): string {
  const ms = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ms)) {
    return new Date().toISOString().slice(0, 16) + ":00.000Z";
  }
  return new Date(ms).toISOString().slice(0, 16) + ":00.000Z";
}

/**
 * Upsert poll ticks for one meeting poll (batch). Compacts to one row per
 * race per UTC minute. Treated as essential (same class as odds).
 */
export async function recordPollTicks(
  env: Env,
  meetingDate: string,
  venue: string,
  ticks: PollTickInput[],
): Promise<number> {
  if (ticks.length === 0) return 0;
  if (!(await allowD1Write(env, "odds"))) return 0;

  const stmts: D1PreparedStatement[] = [];
  for (const t of ticks) {
    if (!Number.isFinite(t.race_no) || t.race_no <= 0) continue;
    const tickAt = t.tick_at ?? new Date().toISOString();
    const minute = tickMinuteBucket(tickAt);
    const changed = t.changed ? 1 : 0;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO poll_ticks
          (meeting_date, venue, race_no, tick_minute, changed, last_tick_at, tick_count)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(meeting_date, venue, race_no, tick_minute) DO UPDATE SET
           changed = CASE
             WHEN excluded.changed > poll_ticks.changed THEN excluded.changed
             ELSE poll_ticks.changed
           END,
           last_tick_at = CASE
             WHEN excluded.last_tick_at > poll_ticks.last_tick_at THEN excluded.last_tick_at
             ELSE poll_ticks.last_tick_at
           END,
           tick_count = poll_ticks.tick_count + 1`,
      ).bind(meetingDate, venue, t.race_no, minute, changed, tickAt),
    );
  }
  if (stmts.length === 0) return 0;

  const results = await env.DB.batch(stmts);
  for (const r of results) {
    await trackD1Result(env, r);
  }
  return stmts.length;
}

export async function listPollTicks(
  db: D1Database,
  meetingDate: string,
  venue: string,
  raceNo?: number,
): Promise<PollTickRow[]> {
  if (raceNo != null) {
    const { results } = await db
      .prepare(
        `SELECT meeting_date, venue, race_no, tick_minute, changed, last_tick_at, tick_count
         FROM poll_ticks
         WHERE meeting_date=? AND venue=? AND race_no=?
         ORDER BY tick_minute ASC`,
      )
      .bind(meetingDate, venue, raceNo)
      .all<PollTickRow>();
    return results ?? [];
  }
  const { results } = await db
    .prepare(
      `SELECT meeting_date, venue, race_no, tick_minute, changed, last_tick_at, tick_count
       FROM poll_ticks
       WHERE meeting_date=? AND venue=?
       ORDER BY race_no ASC, tick_minute ASC`,
    )
    .bind(meetingDate, venue)
    .all<PollTickRow>();
  return results ?? [];
}

/**
 * Detect gaps > threshold between consecutive tick timestamps for one race.
 * Also flags a trailing gap from last tick to `nowMs` when provided.
 */
export function detectGapsForRace(args: {
  race_no: number;
  ticks: Array<{ last_tick_at: string }>;
  thresholdMs?: number;
  /** Inclusive window start; if first tick is later, counts as a leading gap. */
  windowFromMs?: number | null;
  /** End of observation (default: last tick only; pass Date.now() for live). */
  nowMs?: number | null;
}): PollGap[] {
  const threshold = args.thresholdMs ?? POLL_GAP_THRESHOLD_MS;
  const times = args.ticks
    .map((t) => Date.parse(t.last_tick_at))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  const gaps: PollGap[] = [];

  if (times.length === 0) {
    if (
      args.windowFromMs != null &&
      args.nowMs != null &&
      args.nowMs - args.windowFromMs > threshold
    ) {
      gaps.push({
        race_no: args.race_no,
        from: new Date(args.windowFromMs).toISOString(),
        to: new Date(args.nowMs).toISOString(),
        gap_ms: args.nowMs - args.windowFromMs,
      });
    }
    return gaps;
  }

  if (args.windowFromMs != null && times[0] - args.windowFromMs > threshold) {
    gaps.push({
      race_no: args.race_no,
      from: new Date(args.windowFromMs).toISOString(),
      to: new Date(times[0]).toISOString(),
      gap_ms: times[0] - args.windowFromMs,
    });
  }

  for (let i = 1; i < times.length; i++) {
    const gapMs = times[i] - times[i - 1];
    if (gapMs > threshold) {
      gaps.push({
        race_no: args.race_no,
        from: new Date(times[i - 1]).toISOString(),
        to: new Date(times[i]).toISOString(),
        gap_ms: gapMs,
      });
    }
  }

  if (args.nowMs != null) {
    const last = times[times.length - 1];
    const gapMs = args.nowMs - last;
    if (gapMs > threshold) {
      gaps.push({
        race_no: args.race_no,
        from: new Date(last).toISOString(),
        to: new Date(args.nowMs).toISOString(),
        gap_ms: gapMs,
      });
    }
  }

  return gaps;
}

/**
 * Build coverage intervals for one race: between ticks, classify as
 * changed / static (tick present) or missing (no tick → gap).
 */
export function buildCoverageIntervals(args: {
  ticks: PollTickRow[];
  thresholdMs?: number;
  nowMs?: number | null;
}): CoverageInterval[] {
  const threshold = args.thresholdMs ?? POLL_GAP_THRESHOLD_MS;
  const sorted = [...args.ticks].sort((a, b) =>
    a.last_tick_at.localeCompare(b.last_tick_at),
  );
  const out: CoverageInterval[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const fromMs = Date.parse(prev.last_tick_at);
    const toMs = Date.parse(cur.last_tick_at);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) continue;
    const gapMs = toMs - fromMs;
    if (gapMs > threshold) {
      out.push({
        from: prev.last_tick_at,
        to: cur.last_tick_at,
        kind: "missing",
        gap_ms: gapMs,
        race_no: cur.race_no,
      });
    } else {
      out.push({
        from: prev.last_tick_at,
        to: cur.last_tick_at,
        kind: cur.changed ? "changed" : "static",
        gap_ms: gapMs,
        race_no: cur.race_no,
      });
    }
  }

  if (args.nowMs != null && sorted.length > 0) {
    const last = sorted[sorted.length - 1];
    const lastMs = Date.parse(last.last_tick_at);
    if (Number.isFinite(lastMs)) {
      const gapMs = args.nowMs - lastMs;
      if (gapMs > threshold) {
        out.push({
          from: last.last_tick_at,
          to: new Date(args.nowMs).toISOString(),
          kind: "missing",
          gap_ms: gapMs,
          race_no: last.race_no,
        });
      }
    }
  }

  return out;
}

export async function loadRaceCoverage(args: {
  db: D1Database;
  meeting_date: string;
  venue: string;
  race_no: number;
  nowMs?: number | null;
  thresholdMs?: number;
}): Promise<{
  ticks: PollTickRow[];
  gaps: PollGap[];
  intervals: CoverageInterval[];
  gap_threshold_ms: number;
}> {
  const ticks = await listPollTicks(
    args.db,
    args.meeting_date,
    args.venue,
    args.race_no,
  );
  const thresholdMs = args.thresholdMs ?? POLL_GAP_THRESHOLD_MS;
  const gaps = detectGapsForRace({
    race_no: args.race_no,
    ticks,
    thresholdMs,
    nowMs: args.nowMs ?? null,
  });
  const intervals = buildCoverageIntervals({
    ticks,
    thresholdMs,
    nowMs: args.nowMs ?? null,
  });
  return { ticks, gaps, intervals, gap_threshold_ms: thresholdMs };
}

/** Latest tick time per race for a meeting (cheap index seeks). */
export async function latestTickByRace(
  db: D1Database,
  meetingDate: string,
  venue: string,
): Promise<Map<number, string>> {
  const { results } = await db
    .prepare(
      `SELECT race_no, MAX(last_tick_at) AS last_tick_at
       FROM poll_ticks
       WHERE meeting_date=? AND venue=?
       GROUP BY race_no`,
    )
    .bind(meetingDate, venue)
    .all<{ race_no: number; last_tick_at: string }>();
  const map = new Map<number, string>();
  for (const r of results ?? []) {
    map.set(r.race_no, r.last_tick_at);
  }
  return map;
}

export const POLL_GAP_META_KEY = "odds_coverage_gap";
/** Last alerted signature — used so we only push on transition / change. */
export const POLL_GAP_ALERT_SIG_KEY = "odds_coverage_gap_alert_sig";

export interface PollGapAlertState {
  meeting_date: string;
  venue: string;
  gaps: PollGap[];
  threshold_ms: number;
  updated_at: string;
  /** Stable signature for dedupe (sorted race_no|from|to). */
  signature: string;
}

export function gapAlertSignature(gaps: PollGap[]): string {
  return gaps
    .map((g) => `${g.race_no}|${g.from}|${g.to}`)
    .sort()
    .join(";");
}

/**
 * Detect gaps > threshold for the given races, persist cheap meta for /health,
 * and emit `odds_coverage_gap` only when the gap set changes (no push noise).
 * Event is not LIVE_PUSH-gated (ops alert); delivery still respects quiet hours
 * and raceday window via the normal fan-out path.
 */
export async function evaluateAndAlertCoverageGaps(
  env: Env,
  args: {
    meeting_date: string;
    venue: string;
    race_nos: number[];
    captured_at: string;
    sample_interval_s: number | null;
    nowMs?: number;
    thresholdMs?: number;
    /** Injected for tests; defaults to emitPush. */
    emit?: typeof import("../push/emit").emitPush;
  },
): Promise<PollGapAlertState | null> {
  const nowMs = args.nowMs ?? Date.now();
  const thresholdMs = args.thresholdMs ?? POLL_GAP_THRESHOLD_MS;
  const allGaps: PollGap[] = [];

  for (const race_no of args.race_nos) {
    if (!Number.isFinite(race_no) || race_no <= 0) continue;
    const ticks = await listPollTicks(
      env.DB,
      args.meeting_date,
      args.venue,
      race_no,
    );
    allGaps.push(
      ...detectGapsForRace({
        race_no,
        ticks,
        thresholdMs,
        nowMs,
      }),
    );
  }

  const { getMeta, setMeta } = await import("./db");
  const updated_at = new Date(nowMs).toISOString();
  const signature = gapAlertSignature(allGaps);
  const state: PollGapAlertState = {
    meeting_date: args.meeting_date,
    venue: args.venue,
    gaps: allGaps,
    threshold_ms: thresholdMs,
    updated_at,
    signature,
  };

  if (allGaps.length === 0) {
    await setMeta(env.DB, POLL_GAP_META_KEY, JSON.stringify(state));
    // Clear alert signature so a later identical gap set can alert again.
    const prevSig = await getMeta(env.DB, POLL_GAP_ALERT_SIG_KEY);
    if (prevSig) {
      await setMeta(env.DB, POLL_GAP_ALERT_SIG_KEY, "");
    }
    return state;
  }

  await setMeta(env.DB, POLL_GAP_META_KEY, JSON.stringify(state));

  const lastAlerted = (await getMeta(env.DB, POLL_GAP_ALERT_SIG_KEY)) ?? "";
  if (lastAlerted === signature) {
    return state;
  }

  const emitFn =
    args.emit ?? (await import("../push/emit")).emitPush;
  await emitFn(env, {
    event: "odds_coverage_gap",
    meeting_date: args.meeting_date,
    venue: args.venue,
    races: [],
    captured_at: args.captured_at,
    sample_interval_s: args.sample_interval_s,
    meta: {
      threshold_ms: thresholdMs,
      gap_count: allGaps.length,
      gaps: allGaps,
      signature,
    },
  });
  await setMeta(env.DB, POLL_GAP_ALERT_SIG_KEY, signature);
  return state;
}
