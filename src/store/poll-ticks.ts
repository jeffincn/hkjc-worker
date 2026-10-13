/**
 * Poll presence ticks for odds coverage (issue #26, R1b).
 *
 * odds_snapshots skip writes when content hash is unchanged, so a quiet
 * stretch looks identical to a polling outage. poll_ticks records one row
 * per poll per race (no compaction — C1).
 */
import type { Env } from "../env";
import { allowD1Write, trackD1Result } from "./d1-budget";

/** Gaps longer than this are COLLECTION_FAILURE (R2). */
export const POLL_GAP_THRESHOLD_MS = 10 * 60 * 1000;

export const COLLECTION_FAILURE = "COLLECTION_FAILURE" as const;

export interface PollTickInput {
  race_no: number;
  /** True when this poll inserted a new odds_snapshots row. */
  changed: boolean;
  /** ISO timestamp of the poll (defaults to now). */
  tick_time?: string;
}

export interface PollTickRow {
  meeting_date: string;
  venue: string;
  race_no: number;
  tick_time: string;
  changed: number;
}

export interface PollGap {
  race_no: number;
  from: string;
  to: string;
  gap_ms: number;
  /** Always COLLECTION_FAILURE when gap > threshold (R2). */
  kind: typeof COLLECTION_FAILURE;
}

/** A2: /v1/odds/history answers STATIC vs MISSING for any (race, time_range). */
export type CoverageKind = "STATIC" | "MISSING";

export interface CoverageInterval {
  from: string;
  to: string;
  kind: CoverageKind;
  gap_ms: number;
  race_no?: number;
  /** True when the ending tick wrote a new odds snapshot (informational). */
  changed?: boolean;
}

/**
 * Insert one row per poll per race (R1b). No compaction / merge (C1).
 * Treated as essential (same class as odds).
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
    const tickTime = t.tick_time ?? new Date().toISOString();
    const changed = t.changed ? 1 : 0;
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO poll_ticks
          (meeting_date, venue, race_no, tick_time, changed)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(meetingDate, venue, t.race_no, tickTime, changed),
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
  opts?: { from?: string | null; to?: string | null },
): Promise<PollTickRow[]> {
  const from = opts?.from ?? null;
  const to = opts?.to ?? null;
  if (raceNo != null) {
    let sql = `SELECT meeting_date, venue, race_no, tick_time, changed
       FROM poll_ticks
       WHERE meeting_date=? AND venue=? AND race_no=?`;
    const binds: Array<string | number> = [meetingDate, venue, raceNo];
    if (from) {
      sql += ` AND tick_time >= ?`;
      binds.push(from);
    }
    if (to) {
      sql += ` AND tick_time <= ?`;
      binds.push(to);
    }
    sql += ` ORDER BY tick_time ASC`;
    const { results } = await db.prepare(sql).bind(...binds).all<PollTickRow>();
    return results ?? [];
  }
  let sql = `SELECT meeting_date, venue, race_no, tick_time, changed
     FROM poll_ticks
     WHERE meeting_date=? AND venue=?`;
  const binds: string[] = [meetingDate, venue];
  if (from) {
    sql += ` AND tick_time >= ?`;
    binds.push(from);
  }
  if (to) {
    sql += ` AND tick_time <= ?`;
    binds.push(to);
  }
  sql += ` ORDER BY race_no ASC, tick_time ASC`;
  const { results } = await db.prepare(sql).bind(...binds).all<PollTickRow>();
  return results ?? [];
}

/**
 * Detect gaps > threshold between consecutive tick timestamps for one race.
 * Also flags a trailing gap from last tick to `nowMs` when provided.
 * Every returned gap is COLLECTION_FAILURE (R2).
 */
export function detectGapsForRace(args: {
  race_no: number;
  ticks: Array<{ tick_time: string }>;
  thresholdMs?: number;
  /** Inclusive window start; if first tick is later, counts as a leading gap. */
  windowFromMs?: number | null;
  /** End of observation (default: last tick only; pass Date.now() for live). */
  nowMs?: number | null;
}): PollGap[] {
  const threshold = args.thresholdMs ?? POLL_GAP_THRESHOLD_MS;
  const times = args.ticks
    .map((t) => Date.parse(t.tick_time))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  const gaps: PollGap[] = [];

  const pushGap = (fromMs: number, toMs: number) => {
    const gap_ms = toMs - fromMs;
    if (gap_ms > threshold) {
      gaps.push({
        race_no: args.race_no,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        gap_ms,
        kind: COLLECTION_FAILURE,
      });
    }
  };

  if (times.length === 0) {
    if (args.windowFromMs != null && args.nowMs != null) {
      pushGap(args.windowFromMs, args.nowMs);
    }
    return gaps;
  }

  if (args.windowFromMs != null) {
    pushGap(args.windowFromMs, times[0]!);
  }

  for (let i = 1; i < times.length; i++) {
    pushGap(times[i - 1]!, times[i]!);
  }

  if (args.nowMs != null) {
    pushGap(times[times.length - 1]!, args.nowMs);
  }

  return gaps;
}

/**
 * Build coverage intervals for one race: between ticks, classify as
 * STATIC (tick present) or MISSING (gap > threshold → COLLECTION_FAILURE).
 */
export function buildCoverageIntervals(args: {
  ticks: PollTickRow[];
  thresholdMs?: number;
  nowMs?: number | null;
  windowFromMs?: number | null;
}): CoverageInterval[] {
  const threshold = args.thresholdMs ?? POLL_GAP_THRESHOLD_MS;
  const sorted = [...args.ticks].sort((a, b) =>
    a.tick_time.localeCompare(b.tick_time),
  );
  const out: CoverageInterval[] = [];

  if (
    args.windowFromMs != null &&
    sorted.length > 0
  ) {
    const firstMs = Date.parse(sorted[0]!.tick_time);
    if (Number.isFinite(firstMs) && firstMs - args.windowFromMs > threshold) {
      out.push({
        from: new Date(args.windowFromMs).toISOString(),
        to: sorted[0]!.tick_time,
        kind: "MISSING",
        gap_ms: firstMs - args.windowFromMs,
        race_no: sorted[0]!.race_no,
      });
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const fromMs = Date.parse(prev.tick_time);
    const toMs = Date.parse(cur.tick_time);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) continue;
    const gapMs = toMs - fromMs;
    if (gapMs > threshold) {
      out.push({
        from: prev.tick_time,
        to: cur.tick_time,
        kind: "MISSING",
        gap_ms: gapMs,
        race_no: cur.race_no,
      });
    } else {
      out.push({
        from: prev.tick_time,
        to: cur.tick_time,
        kind: "STATIC",
        gap_ms: gapMs,
        race_no: cur.race_no,
        changed: cur.changed === 1,
      });
    }
  }

  if (args.nowMs != null && sorted.length > 0) {
    const last = sorted[sorted.length - 1]!;
    const lastMs = Date.parse(last.tick_time);
    if (Number.isFinite(lastMs)) {
      const gapMs = args.nowMs - lastMs;
      if (gapMs > threshold) {
        out.push({
          from: last.tick_time,
          to: new Date(args.nowMs).toISOString(),
          kind: "MISSING",
          gap_ms: gapMs,
          race_no: last.race_no,
        });
      }
    }
  }

  if (sorted.length === 0 && args.windowFromMs != null && args.nowMs != null) {
    const gapMs = args.nowMs - args.windowFromMs;
    if (gapMs > threshold) {
      out.push({
        from: new Date(args.windowFromMs).toISOString(),
        to: new Date(args.nowMs).toISOString(),
        kind: "MISSING",
        gap_ms: gapMs,
      });
    }
  }

  return out;
}

/**
 * A2: answer STATIC vs MISSING for a (race, time_range).
 * MISSING if any COLLECTION_FAILURE gap overlaps the range; else STATIC
 * when at least one tick is in/adjacent to the range; MISSING if empty
 * and range length > threshold.
 */
export function answerCoverageForRange(args: {
  ticks: PollTickRow[];
  from: string;
  to: string;
  thresholdMs?: number;
}): {
  kind: CoverageKind;
  from: string;
  to: string;
  gaps: PollGap[];
  intervals: CoverageInterval[];
} {
  const fromMs = Date.parse(args.from);
  const toMs = Date.parse(args.to);
  const threshold = args.thresholdMs ?? POLL_GAP_THRESHOLD_MS;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return {
      kind: "MISSING",
      from: args.from,
      to: args.to,
      gaps: [],
      intervals: [],
    };
  }

  // Include boundary ticks just outside the window so interior gaps are visible.
  const sorted = [...args.ticks].sort((a, b) =>
    a.tick_time.localeCompare(b.tick_time),
  );
  const inOrBorder: PollTickRow[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const ms = Date.parse(sorted[i]!.tick_time);
    if (!Number.isFinite(ms)) continue;
    if (ms >= fromMs && ms <= toMs) {
      inOrBorder.push(sorted[i]!);
    }
  }
  // Nearest tick before `from` and after `to` for gap continuity.
  let before: PollTickRow | null = null;
  let after: PollTickRow | null = null;
  for (const t of sorted) {
    const ms = Date.parse(t.tick_time);
    if (!Number.isFinite(ms)) continue;
    if (ms < fromMs) before = t;
    if (ms > toMs) {
      after = t;
      break;
    }
  }
  const windowTicks = [
    ...(before ? [before] : []),
    ...inOrBorder,
    ...(after ? [after] : []),
  ];

  const race_no = sorted[0]?.race_no ?? 0;
  const gaps = detectGapsForRace({
    race_no,
    ticks: windowTicks,
    thresholdMs: threshold,
    windowFromMs: before ? null : fromMs,
    nowMs: after ? null : toMs,
  }).filter((g) => {
    const gFrom = Date.parse(g.from);
    const gTo = Date.parse(g.to);
    // Overlap with [from, to]
    return gFrom < toMs && gTo > fromMs;
  });

  const intervals = buildCoverageIntervals({
    ticks: windowTicks,
    thresholdMs: threshold,
    windowFromMs: before ? null : fromMs,
    nowMs: after ? null : toMs,
  }).filter((iv) => {
    const a = Date.parse(iv.from);
    const b = Date.parse(iv.to);
    return a < toMs && b > fromMs;
  });

  if (gaps.length > 0 || intervals.some((i) => i.kind === "MISSING")) {
    return {
      kind: "MISSING",
      from: args.from,
      to: args.to,
      gaps,
      intervals,
    };
  }

  if (inOrBorder.length === 0 && toMs - fromMs > threshold) {
    return {
      kind: "MISSING",
      from: args.from,
      to: args.to,
      gaps: [
        {
          race_no,
          from: args.from,
          to: args.to,
          gap_ms: toMs - fromMs,
          kind: COLLECTION_FAILURE,
        },
      ],
      intervals: [
        {
          from: args.from,
          to: args.to,
          kind: "MISSING",
          gap_ms: toMs - fromMs,
          race_no,
        },
      ],
    };
  }

  return {
    kind: "STATIC",
    from: args.from,
    to: args.to,
    gaps: [],
    intervals:
      intervals.length > 0
        ? intervals
        : [
            {
              from: args.from,
              to: args.to,
              kind: "STATIC",
              gap_ms: toMs - fromMs,
              race_no,
            },
          ],
  };
}

export async function loadRaceCoverage(args: {
  db: D1Database;
  meeting_date: string;
  venue: string;
  race_no: number;
  nowMs?: number | null;
  thresholdMs?: number;
  from?: string | null;
  to?: string | null;
}): Promise<{
  ticks: PollTickRow[];
  gaps: PollGap[];
  intervals: CoverageInterval[];
  gap_threshold_ms: number;
  /** Present when from+to provided (A2). */
  range_answer?: {
    kind: CoverageKind;
    from: string;
    to: string;
  };
}> {
  const ticks = await listPollTicks(
    args.db,
    args.meeting_date,
    args.venue,
    args.race_no,
  );
  const thresholdMs = args.thresholdMs ?? POLL_GAP_THRESHOLD_MS;
  const windowFromMs =
    args.from != null ? Date.parse(args.from) : null;
  const nowMs =
    args.to != null
      ? Date.parse(args.to)
      : (args.nowMs ?? null);

  const gaps = detectGapsForRace({
    race_no: args.race_no,
    ticks,
    thresholdMs,
    windowFromMs: Number.isFinite(windowFromMs) ? windowFromMs : null,
    nowMs: nowMs != null && Number.isFinite(nowMs) ? nowMs : null,
  });
  const intervals = buildCoverageIntervals({
    ticks,
    thresholdMs,
    windowFromMs: Number.isFinite(windowFromMs) ? windowFromMs : null,
    nowMs: nowMs != null && Number.isFinite(nowMs) ? nowMs : null,
  });

  let range_answer: { kind: CoverageKind; from: string; to: string } | undefined;
  if (args.from && args.to) {
    const ans = answerCoverageForRange({
      ticks,
      from: args.from,
      to: args.to,
      thresholdMs,
    });
    range_answer = { kind: ans.kind, from: ans.from, to: ans.to };
  }

  return { ticks, gaps, intervals, gap_threshold_ms: thresholdMs, range_answer };
}

/** Latest tick time per race for a meeting (cheap index seeks). */
export async function latestTickByRace(
  db: D1Database,
  meetingDate: string,
  venue: string,
): Promise<Map<number, string>> {
  const { results } = await db
    .prepare(
      `SELECT race_no, MAX(tick_time) AS tick_time
       FROM poll_ticks
       WHERE meeting_date=? AND venue=?
       GROUP BY race_no`,
    )
    .bind(meetingDate, venue)
    .all<{ race_no: number; tick_time: string }>();
  const map = new Map<number, string>();
  for (const r of results ?? []) {
    map.set(r.race_no, r.tick_time);
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
  /** R2 label when any gap present. */
  status: typeof COLLECTION_FAILURE | "OK";
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
    status: allGaps.length > 0 ? COLLECTION_FAILURE : "OK",
    threshold_ms: thresholdMs,
    updated_at,
    signature,
  };

  if (allGaps.length === 0) {
    await setMeta(env.DB, POLL_GAP_META_KEY, JSON.stringify(state));
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
      status: COLLECTION_FAILURE,
      threshold_ms: thresholdMs,
      gap_count: allGaps.length,
      gaps: allGaps,
      signature,
    },
  });
  await setMeta(env.DB, POLL_GAP_ALERT_SIG_KEY, signature);
  return state;
}
