/**
 * Backfill runners.horse_code / results.horse_code for rows left NULL after
 * migration 0010.
 *
 * Why production stayed null:
 * - Auto backfill only ran inside /v1/admin/ingest (not DO poll / deploy).
 * - meetings.raw_json for historical cards often comes from rbcMeeting, which
 *   has runners.no/status but **no horse.code** (whitelist-fixed query).
 * - Live odds_snapshots usually store runner_id = brand code (H087) — best
 *   offline source for race-day meetings that were polled.
 *
 * Modes:
 * - store: D1 only (meetings.raw_json + odds_snapshots) — no HKJC requests
 * - hkjc:  re-fetch raceMeetings FULL for meetings still missing codes
 *          (rate-limited; past dates may return empty — HKJC live-only quirk)
 * - both:  store first, then hkjc for remaining gaps
 */
import type { Env } from "../env";
import { envNum } from "../env";
import { fetchGraphQL } from "../graphql/client";
import { QUERY_RACE_MEETINGS_FULL } from "../graphql/queries";
import type { RaceMeetingsFullData } from "../graphql/types";
import {
  horseCodeFromRunnerFields,
  normalizeHorseCode,
} from "../parse/horse-code";
import { normalizeMeeting } from "../parse/meeting";
import { hkDay, resolveDailyRequestBudget } from "../poll/live";
import {
  ensureHorseStub,
  persistMeetingTree,
} from "../store/db";
import { isD1WriteDegraded } from "../store/d1-budget";
import { addGraphqlUsage, getGraphqlUsage } from "../store/usage";

export type HorseCodeBackfillSource = "store" | "hkjc" | "both";

export interface HorseCodeBackfillOptions {
  source?: HorseCodeBackfillSource;
  /** Max meetings to scan/update (store) or fetch (hkjc). Default 50. */
  limit_meetings?: number;
  date?: string;
  venue?: string;
  /** Delay between HKJC meeting fetches (ms). Default 400. */
  hkjc_delay_ms?: number;
  fetchImpl?: typeof fetch;
}

export interface HorseCodeBackfillResult {
  source: HorseCodeBackfillSource;
  store?: {
    meetings_scanned: number;
    races_from_odds: number;
    runners_updated: number;
    from_meetings_raw: number;
    from_odds_snapshots: number;
  };
  hkjc?: {
    meetings_attempted: number;
    meetings_updated: number;
    meetings_empty: number;
    meetings_skipped_budget: number;
    gql_requests: number;
    runners_updated: number;
  };
  remaining_null_runners: number;
  d1_degraded: boolean;
  notes: string[];
}

async function countNullHorseCodeRunners(
  db: D1Database,
  filter?: { date?: string; venue?: string },
): Promise<number> {
  let sql = `SELECT COUNT(*) AS n FROM runners WHERE (horse_code IS NULL OR horse_code='')`;
  const binds: Array<string | number> = [];
  if (filter?.date) {
    sql += ` AND meeting_date=?`;
    binds.push(filter.date);
  }
  if (filter?.venue) {
    sql += ` AND venue=?`;
    binds.push(filter.venue);
  }
  const stmt = db.prepare(sql);
  const row = await (binds.length ? stmt.bind(...binds) : stmt).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function applyHorseCode(args: {
  db: D1Database;
  meeting_date: string;
  venue: string;
  race_no: number;
  horse_no: number;
  horse_code: string;
  horse_id?: string | null;
  name_en?: string | null;
  name_ch?: string | null;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const upd = await args.db
    .prepare(
      `UPDATE runners SET horse_code=?, updated_at=?
       WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?
         AND (horse_code IS NULL OR horse_code='')`,
    )
    .bind(
      args.horse_code,
      now,
      args.meeting_date,
      args.venue,
      args.race_no,
      args.horse_no,
    )
    .run();
  const changed = (upd.meta?.changes ?? 0) > 0;
  if (changed) {
    await args.db
      .prepare(
        `UPDATE results SET horse_code=?
         WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?
           AND (horse_code IS NULL OR horse_code='')`,
      )
      .bind(
        args.horse_code,
        args.meeting_date,
        args.venue,
        args.race_no,
        args.horse_no,
      )
      .run();
    await ensureHorseStub(args.db, {
      horse_code: args.horse_code,
      horse_id: args.horse_id ?? null,
      name_en: args.name_en ?? null,
      name_ch: args.name_ch ?? null,
    });
  }
  return changed;
}

/** Apply codes found in a GraphQL-shaped meeting.raw_json blob. */
async function applyFromMeetingRaw(
  db: D1Database,
  meetingDate: string,
  venue: string,
  rawJson: string,
): Promise<number> {
  let parsed: {
    races?: Array<{
      no?: number;
      runners?: Array<{
        no?: string | number;
        standbyNo?: string | number;
        horse?: { code?: string; id?: string } | null;
        name_en?: string | null;
        name_ch?: string | null;
      }>;
    }>;
  };
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return 0;
  }
  let updated = 0;
  for (const race of parsed.races ?? []) {
    const raceNo = Number(race.no);
    if (!Number.isFinite(raceNo)) continue;
    for (const r of race.runners ?? []) {
      const code = normalizeHorseCode(r.horse?.code);
      if (!code) continue;
      const primary = Number(r.no);
      const standby = Number(r.standbyNo);
      const horseNo =
        Number.isFinite(primary) && primary > 0
          ? primary
          : Number.isFinite(standby) && standby > 0
            ? standby
            : NaN;
      if (!Number.isFinite(horseNo)) continue;
      const horseId =
        r.horse?.id != null && String(r.horse.id).trim() !== ""
          ? String(r.horse.id).trim()
          : null;
      if (
        await applyHorseCode({
          db,
          meeting_date: meetingDate,
          venue,
          race_no: raceNo,
          horse_no: horseNo,
          horse_code: code,
          horse_id: horseId,
          name_en: r.name_en ?? null,
          name_ch: r.name_ch ?? null,
        })
      ) {
        updated += 1;
      }
    }
  }
  return updated;
}

/** Apply codes from an odds snapshot runners[] (runner_id / horse_code). */
async function applyFromOddsSnapshot(
  db: D1Database,
  meetingDate: string,
  venue: string,
  raceNo: number,
  rawJson: string,
): Promise<number> {
  let parsed: {
    runners?: Array<{
      horse_no?: number;
      horse_code?: string | null;
      runner_id?: string | null;
      horse_name?: string | null;
    }>;
  };
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return 0;
  }
  let updated = 0;
  for (const r of parsed.runners ?? []) {
    const horseNo = Number(r.horse_no);
    if (!Number.isFinite(horseNo) || horseNo <= 0) continue;
    const code = horseCodeFromRunnerFields({
      horse_code: r.horse_code,
      runner_id: r.runner_id,
    });
    if (!code) continue;
    if (
      await applyHorseCode({
        db,
        meeting_date: meetingDate,
        venue,
        race_no: raceNo,
        horse_no: horseNo,
        horse_code: code,
        name_en: r.horse_name ?? null,
      })
    ) {
      updated += 1;
    }
  }
  return updated;
}

/**
 * D1-only backfill: meetings.raw_json (when it has horse.code) + odds_snapshots
 * runner_id brand codes. No HKJC network calls.
 */
export async function backfillHorseCodesFromStore(
  db: D1Database,
  opts?: {
    limitMeetings?: number;
    date?: string;
    venue?: string;
  },
): Promise<NonNullable<HorseCodeBackfillResult["store"]>> {
  const limit = opts?.limitMeetings ?? 50;
  let meetings_scanned = 0;
  let races_from_odds = 0;
  let from_meetings_raw = 0;
  let from_odds_snapshots = 0;

  // 1) meetings.raw_json — useful when live FULL payload was stored
  {
    let sql = `SELECT meeting_date, venue, raw_json FROM meetings WHERE raw_json IS NOT NULL`;
    const binds: Array<string | number> = [];
    if (opts?.date) {
      sql += ` AND meeting_date=?`;
      binds.push(opts.date);
    }
    if (opts?.venue) {
      sql += ` AND venue=?`;
      binds.push(opts.venue);
    }
    sql += ` ORDER BY meeting_date DESC LIMIT ?`;
    binds.push(limit);
    const { results } = await db
      .prepare(sql)
      .bind(...binds)
      .all<{ meeting_date: string; venue: string; raw_json: string }>();
    meetings_scanned = (results ?? []).length;
    for (const row of results ?? []) {
      from_meetings_raw += await applyFromMeetingRaw(
        db,
        row.meeting_date,
        row.venue,
        row.raw_json,
      );
    }
  }

  // 2) odds_snapshots — primary fix for race-day cards (runner_id = H087)
  {
    let sql = `
      SELECT r.meeting_date, r.venue, r.race_no
      FROM runners r
      WHERE (r.horse_code IS NULL OR r.horse_code='')`;
    const binds: Array<string | number> = [];
    if (opts?.date) {
      sql += ` AND r.meeting_date=?`;
      binds.push(opts.date);
    }
    if (opts?.venue) {
      sql += ` AND r.venue=?`;
      binds.push(opts.venue);
    }
    sql += `
      GROUP BY r.meeting_date, r.venue, r.race_no
      ORDER BY r.meeting_date DESC, r.venue ASC, r.race_no ASC
      LIMIT ?`;
    binds.push(limit * 12); // ~12 races/meeting
    const { results: races } = await db
      .prepare(sql)
      .bind(...binds)
      .all<{ meeting_date: string; venue: string; race_no: number }>();

    for (const race of races ?? []) {
      const snap = await db
        .prepare(
          `SELECT raw_json FROM odds_snapshots
           WHERE meeting_date=? AND venue=? AND race_no=?
           ORDER BY snapshot_time DESC, id DESC LIMIT 1`,
        )
        .bind(race.meeting_date, race.venue, race.race_no)
        .first<{ raw_json: string }>();
      if (!snap?.raw_json) continue;
      races_from_odds += 1;
      from_odds_snapshots += await applyFromOddsSnapshot(
        db,
        race.meeting_date,
        race.venue,
        race.race_no,
        snap.raw_json,
      );
    }
  }

  return {
    meetings_scanned,
    races_from_odds,
    runners_updated: from_meetings_raw + from_odds_snapshots,
    from_meetings_raw,
    from_odds_snapshots,
  };
}

/**
 * Re-fetch raceMeetings FULL for meetings that still have null horse_code.
 * Rate-limited; respects DAILY_REQUEST_BUDGET. Past dates may return empty.
 */
export async function backfillHorseCodesFromHkjc(
  env: Env,
  opts?: {
    limitMeetings?: number;
    date?: string;
    venue?: string;
    delayMs?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<NonNullable<HorseCodeBackfillResult["hkjc"]>> {
  const limit = opts?.limitMeetings ?? 10;
  const delayMs = opts?.delayMs ?? 400;
  const budget = resolveDailyRequestBudget(env);
  const day = hkDay(Date.now());
  let used = await getGraphqlUsage(env.DB, day);

  let sql = `
    SELECT DISTINCT meeting_date, venue FROM runners
    WHERE (horse_code IS NULL OR horse_code='')`;
  const binds: string[] = [];
  if (opts?.date) {
    sql += ` AND meeting_date=?`;
    binds.push(opts.date);
  }
  if (opts?.venue) {
    sql += ` AND venue=?`;
    binds.push(opts.venue);
  }
  sql += ` ORDER BY meeting_date DESC LIMIT ?`;
  binds.push(String(limit));

  // LIMIT bind must be number for D1
  const bindVals: Array<string | number> = [...binds.slice(0, -1), limit];
  const { results } = await env.DB.prepare(sql)
    .bind(...bindVals)
    .all<{ meeting_date: string; venue: string }>();

  let meetings_attempted = 0;
  let meetings_updated = 0;
  let meetings_empty = 0;
  let meetings_skipped_budget = 0;
  let gql_requests = 0;
  let runners_updated = 0;

  for (const m of results ?? []) {
    if (used + 1 > budget) {
      meetings_skipped_budget += 1;
      continue;
    }
    if (await isD1WriteDegraded(env)) {
      meetings_skipped_budget += 1;
      break;
    }
    meetings_attempted += 1;
    if (delayMs > 0 && meetings_attempted > 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    try {
      const res = await fetchGraphQL<RaceMeetingsFullData>({
        query: QUERY_RACE_MEETINGS_FULL,
        variables: { date: m.meeting_date, venueCode: m.venue },
        fetchImpl: opts?.fetchImpl,
      });
      gql_requests += 1;
      used = await addGraphqlUsage(env.DB, day, 1);

      const found =
        (res.data?.raceMeetings ?? []).find(
          (x) => x.date === m.meeting_date && x.venueCode === m.venue,
        ) ?? res.data?.raceMeetings?.[0] ?? null;

      if (!found || found.date !== m.meeting_date || found.venueCode !== m.venue) {
        meetings_empty += 1;
        continue;
      }

      const before = await countNullHorseCodeRunners(env.DB, {
        date: m.meeting_date,
        venue: m.venue,
      });
      const meeting = normalizeMeeting(found, "graphql");
      await persistMeetingTree(env.DB, meeting, found);
      const after = await countNullHorseCodeRunners(env.DB, {
        date: m.meeting_date,
        venue: m.venue,
      });
      const filled = Math.max(0, before - after);
      runners_updated += filled;
      if (filled > 0) meetings_updated += 1;
      else meetings_empty += 1;
    } catch {
      meetings_empty += 1;
    }
  }

  return {
    meetings_attempted,
    meetings_updated,
    meetings_empty,
    meetings_skipped_budget,
    gql_requests,
    runners_updated,
  };
}

/** Orchestrate store / hkjc / both. */
export async function runHorseCodeBackfill(
  env: Env,
  opts?: HorseCodeBackfillOptions,
): Promise<HorseCodeBackfillResult> {
  const source: HorseCodeBackfillSource = opts?.source ?? "store";
  const limit = opts?.limit_meetings ?? (source === "hkjc" ? 10 : 50);
  const notes: string[] = [];
  const d1_degraded = await isD1WriteDegraded(env);
  if (d1_degraded) {
    notes.push("D1 write budget degraded — skipping / limiting writes");
  }

  const result: HorseCodeBackfillResult = {
    source,
    remaining_null_runners: 0,
    d1_degraded,
    notes,
  };

  if (source === "store" || source === "both") {
    if (!d1_degraded) {
      result.store = await backfillHorseCodesFromStore(env.DB, {
        limitMeetings: limit,
        date: opts?.date,
        venue: opts?.venue,
      });
      notes.push(
        "store: meetings.raw_json often lacks horse.code (rbcMeeting); odds_snapshots.runner_id is the main offline source",
      );
    }
  }

  if (source === "hkjc" || source === "both") {
    if (d1_degraded) {
      notes.push("hkjc skipped: D1 degraded");
    } else {
      result.hkjc = await backfillHorseCodesFromHkjc(env, {
        limitMeetings: Math.min(limit, envNum(env, "HORSE_REFRESH_BATCH", 10) || 10),
        date: opts?.date,
        venue: opts?.venue,
        delayMs: opts?.hkjc_delay_ms ?? 400,
        fetchImpl: opts?.fetchImpl,
      });
      notes.push(
        "hkjc: uses whitelisted raceMeetings FULL; past dates may return empty (HKJC live-only)",
      );
    }
  }

  result.remaining_null_runners = await countNullHorseCodeRunners(env.DB, {
    date: opts?.date,
    venue: opts?.venue,
  });
  return result;
}

/** @deprecated — kept for ingest import compatibility; prefer runHorseCodeBackfill. */
export async function backfillHorseCodesFromRawMeetings(
  db: D1Database,
  opts?: { limitMeetings?: number },
): Promise<{ meetings_scanned: number; runners_updated: number }> {
  const store = await backfillHorseCodesFromStore(db, opts);
  return {
    meetings_scanned: store.meetings_scanned,
    runners_updated: store.runners_updated,
  };
}
