/**
 * Backfill runners.horse_code / results.horse_code for rows left NULL after
 * migration 0010.
 *
 * Identity rule (critical):
 * Never assign horse_code by horse_no alone when Declared + Standby share a
 * cloth number. Standby uses standbyNo which often equals a Declared `no`.
 * Match by unique identity: name_en (preferred), else horse_no only when that
 * cloth is unique in the source and the DB row is not Standby.
 *
 * Modes:
 * - store: D1 only (meetings.raw_json + odds_snapshots) — no HKJC requests
 * - hkjc:  re-fetch raceMeetings FULL for meetings still missing codes
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
import { ensureHorseStub, persistMeetingTree } from "../store/db";
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
  /** Clear ambiguously assigned codes before backfill. */
  reset_ambiguous?: boolean;
}

export interface HorseCodeResetResult {
  cleared_standby: number;
  cleared_cloth_collision: number;
  cleared_name_mismatch: number;
  cleared_total: number;
}

export interface HorseCodeBackfillResult {
  source: HorseCodeBackfillSource;
  reset?: HorseCodeResetResult;
  store?: {
    meetings_scanned: number;
    races_from_odds: number;
    runners_updated: number;
    from_meetings_raw: number;
    from_odds_snapshots: number;
    skipped_ambiguous: number;
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

/** Normalize horse names for equality (case / quotes / whitespace). */
export function normalizeHorseName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw)
    .trim()
    .toUpperCase()
    .replace(/[''`´]/g, "")
    .replace(/\s+/g, " ");
  return s === "" ? null : s;
}

export function isStandbyStatus(status: string | null | undefined): boolean {
  return (status ?? "").toUpperCase().includes("STANDBY");
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

function meetingFilterSql(
  alias: string,
  filter?: { date?: string; venue?: string },
): { sql: string; binds: string[] } {
  const binds: string[] = [];
  let sql = "";
  if (filter?.date) {
    sql += ` AND ${alias}.meeting_date=?`;
    binds.push(filter.date);
  }
  if (filter?.venue) {
    sql += ` AND ${alias}.venue=?`;
    binds.push(filter.venue);
  }
  return { sql, binds };
}

/**
 * Assign horse_code only via unique identity:
 * - Prefer exact name_en match (normalized)
 * - Else horse_no only when cloth is unique in source AND target row is not Standby
 */
async function applyHorseCodeByIdentity(args: {
  db: D1Database;
  meeting_date: string;
  venue: string;
  race_no: number;
  horse_code: string;
  horse_id?: string | null;
  name_en?: string | null;
  name_ch?: string | null;
  horse_no?: number | null;
  /** True when Declared+Standby share this cloth in the source payload. */
  cloth_collision: boolean;
  source_status?: string | null;
}): Promise<"updated" | "skipped"> {
  const now = new Date().toISOString();
  const nameKey = normalizeHorseName(args.name_en);

  // 1) Name match — safe across Declared/Standby
  if (nameKey) {
    const { results } = await args.db
      .prepare(
        `SELECT horse_no, name_en, status, horse_code FROM runners
         WHERE meeting_date=? AND venue=? AND race_no=?`,
      )
      .bind(args.meeting_date, args.venue, args.race_no)
      .all<{
        horse_no: number;
        name_en: string | null;
        status: string | null;
        horse_code: string | null;
      }>();
    const matches = (results ?? []).filter(
      (r) => normalizeHorseName(r.name_en) === nameKey,
    );
    if (matches.length === 1) {
      const row = matches[0];
      if (row.horse_code && row.horse_code !== "") {
        return row.horse_code === args.horse_code ? "skipped" : "skipped";
      }
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
          row.horse_no,
        )
        .run();
      if ((upd.meta?.changes ?? 0) > 0) {
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
            row.horse_no,
          )
          .run();
        await ensureHorseStub(args.db, {
          horse_code: args.horse_code,
          horse_id: args.horse_id ?? null,
          name_en: args.name_en ?? row.name_en,
          name_ch: args.name_ch ?? null,
        });
        return "updated";
      }
      return "skipped";
    }
    if (matches.length !== 1) {
      // Ambiguous or missing name in DB — do not fall through to horse_no when
      // we had a source name (avoids Declared code landing on Standby row).
      return "skipped";
    }
  }

  // 2) horse_no fallback — only when cloth is unique and target is not Standby
  if (
    args.cloth_collision ||
    args.horse_no == null ||
    !Number.isFinite(args.horse_no) ||
    args.horse_no <= 0 ||
    isStandbyStatus(args.source_status)
  ) {
    return "skipped";
  }

  const target = await args.db
    .prepare(
      `SELECT horse_no, name_en, status, horse_code FROM runners
       WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?`,
    )
    .bind(args.meeting_date, args.venue, args.race_no, args.horse_no)
    .first<{
      horse_no: number;
      name_en: string | null;
      status: string | null;
      horse_code: string | null;
    }>();
  if (!target) return "skipped";
  if (isStandbyStatus(target.status)) return "skipped";
  if (target.horse_code && target.horse_code !== "") return "skipped";

  const upd = await args.db
    .prepare(
      `UPDATE runners SET horse_code=?, updated_at=?
       WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?
         AND (horse_code IS NULL OR horse_code='')
         AND upper(coalesce(status,'')) NOT LIKE '%STANDBY%'`,
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
  if ((upd.meta?.changes ?? 0) > 0) {
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
      name_en: args.name_en ?? target.name_en,
      name_ch: args.name_ch ?? null,
    });
    return "updated";
  }
  return "skipped";
}

/** Cloth numbers that appear with 2+ distinct brand codes (Declared+Standby). */
export function collidingClothNumbers(
  runners: Array<{
    horse_no?: number | null;
    horse_code?: string | null;
    runner_id?: string | null;
    status?: string | null;
    horse_name?: string | null;
  }>,
): Set<number> {
  const codesByCloth = new Map<number, Set<string>>();
  for (const r of runners) {
    const horseNo = Number(r.horse_no);
    if (!Number.isFinite(horseNo) || horseNo <= 0) continue;
    const code = horseCodeFromRunnerFields({
      horse_code: r.horse_code,
      runner_id: r.runner_id,
    });
    if (!code) continue;
    const set = codesByCloth.get(horseNo) ?? new Set<string>();
    set.add(code);
    codesByCloth.set(horseNo, set);
  }
  const colliding = new Set<number>();
  for (const [no, codes] of codesByCloth) {
    if (codes.size > 1) colliding.add(no);
  }
  // Also: same cloth with Declared + Standby statuses even if one lacks code yet
  const statusesByCloth = new Map<number, Set<string>>();
  for (const r of runners) {
    const horseNo = Number(r.horse_no);
    if (!Number.isFinite(horseNo) || horseNo <= 0) continue;
    const kind = isStandbyStatus(r.status) ? "S" : "D";
    const set = statusesByCloth.get(horseNo) ?? new Set<string>();
    set.add(kind);
    statusesByCloth.set(horseNo, set);
  }
  for (const [no, kinds] of statusesByCloth) {
    if (kinds.has("S") && kinds.has("D")) colliding.add(no);
  }
  return colliding;
}

async function applyFromMeetingRaw(
  db: D1Database,
  meetingDate: string,
  venue: string,
  rawJson: string,
): Promise<{ updated: number; skipped: number }> {
  let parsed: {
    races?: Array<{
      no?: number;
      runners?: Array<{
        no?: string | number;
        standbyNo?: string | number;
        status?: string | null;
        horse?: { code?: string; id?: string } | null;
        name_en?: string | null;
        name_ch?: string | null;
      }>;
    }>;
  };
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { updated: 0, skipped: 0 };
  }
  let updated = 0;
  let skipped = 0;
  for (const race of parsed.races ?? []) {
    const raceNo = Number(race.no);
    if (!Number.isFinite(raceNo)) continue;
    const normalized = (race.runners ?? []).map((r) => {
      const primary = Number(r.no);
      const standby = Number(r.standbyNo);
      const standbyEntry =
        isStandbyStatus(r.status) ||
        (!(Number.isFinite(primary) && primary > 0) &&
          Number.isFinite(standby) &&
          standby > 0);
      const horse_no = standbyEntry
        ? Number.isFinite(standby) && standby > 0
          ? standby
          : Number.isFinite(primary) && primary > 0
            ? primary
            : NaN
        : Number.isFinite(primary) && primary > 0
          ? primary
          : Number.isFinite(standby) && standby > 0
            ? standby
            : NaN;
      return {
        horse_no,
        horse_code: normalizeHorseCode(r.horse?.code),
        runner_id: normalizeHorseCode(r.horse?.code),
        status: standbyEntry ? "Standby" : (r.status ?? "Declared"),
        name_en: r.name_en ?? null,
        name_ch: r.name_ch ?? null,
        horse_id:
          r.horse?.id != null && String(r.horse.id).trim() !== ""
            ? String(r.horse.id).trim()
            : null,
      };
    });
    const colliding = collidingClothNumbers(normalized);
    for (const r of normalized) {
      if (!r.horse_code || !Number.isFinite(r.horse_no)) {
        skipped += 1;
        continue;
      }
      const result = await applyHorseCodeByIdentity({
        db,
        meeting_date: meetingDate,
        venue,
        race_no: raceNo,
        horse_code: r.horse_code,
        horse_id: r.horse_id,
        name_en: r.name_en,
        name_ch: r.name_ch,
        horse_no: r.horse_no,
        cloth_collision: colliding.has(r.horse_no),
        source_status: r.status,
      });
      if (result === "updated") updated += 1;
      else skipped += 1;
    }
  }
  return { updated, skipped };
}

async function applyFromOddsSnapshot(
  db: D1Database,
  meetingDate: string,
  venue: string,
  raceNo: number,
  rawJson: string,
): Promise<{ updated: number; skipped: number }> {
  let parsed: {
    runners?: Array<{
      horse_no?: number;
      horse_code?: string | null;
      runner_id?: string | null;
      horse_name?: string | null;
      status?: string | null;
    }>;
  };
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { updated: 0, skipped: 0 };
  }
  const runners = parsed.runners ?? [];
  const colliding = collidingClothNumbers(runners);
  let updated = 0;
  let skipped = 0;
  for (const r of runners) {
    const horseNo = Number(r.horse_no);
    const code = horseCodeFromRunnerFields({
      horse_code: r.horse_code,
      runner_id: r.runner_id,
    });
    if (!code || !Number.isFinite(horseNo) || horseNo <= 0) {
      skipped += 1;
      continue;
    }
    const result = await applyHorseCodeByIdentity({
      db,
      meeting_date: meetingDate,
      venue,
      race_no: raceNo,
      horse_code: code,
      name_en: r.horse_name ?? null,
      horse_no: horseNo,
      cloth_collision: colliding.has(horseNo),
      source_status: r.status,
    });
    if (result === "updated") updated += 1;
    else skipped += 1;
  }
  return { updated, skipped };
}

/**
 * Clear horse_codes that were likely assigned by cloth-number collision
 * (Standby rows, Declared+Standby shared cloth in odds, name≠code profile).
 */
export async function resetAmbiguousHorseCodes(
  db: D1Database,
  filter?: { date?: string; venue?: string },
): Promise<HorseCodeResetResult> {
  const now = new Date().toISOString();
  const mf = meetingFilterSql("runners", filter);

  // 1) All Standby rows — never trust horse_no-only assignment
  const standby = await db
    .prepare(
      `UPDATE runners SET horse_code=NULL, updated_at=?
       WHERE horse_code IS NOT NULL AND horse_code!=''
         AND upper(coalesce(status,'')) LIKE '%STANDBY%'${mf.sql}`,
    )
    .bind(now, ...mf.binds)
    .run();
  const cleared_standby = standby.meta?.changes ?? 0;

  // 2) Cloth collisions visible in latest odds snapshots
  let sqlRaces = `
    SELECT DISTINCT meeting_date, venue, race_no FROM runners
    WHERE horse_code IS NOT NULL AND horse_code!=''`;
  const raceBinds: Array<string | number> = [];
  if (filter?.date) {
    sqlRaces += ` AND meeting_date=?`;
    raceBinds.push(filter.date);
  }
  if (filter?.venue) {
    sqlRaces += ` AND venue=?`;
    raceBinds.push(filter.venue);
  }
  const { results: races } = await db
    .prepare(sqlRaces)
    .bind(...raceBinds)
    .all<{ meeting_date: string; venue: string; race_no: number }>();

  let cleared_cloth_collision = 0;
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
    let runners: Array<{
      horse_no?: number;
      horse_code?: string | null;
      runner_id?: string | null;
      status?: string | null;
      horse_name?: string | null;
    }> = [];
    try {
      runners = (JSON.parse(snap.raw_json) as { runners?: typeof runners }).runners ?? [];
    } catch {
      continue;
    }
    const colliding = collidingClothNumbers(runners);
    for (const horseNo of colliding) {
      const upd = await db
        .prepare(
          `UPDATE runners SET horse_code=NULL, updated_at=?
           WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?
             AND horse_code IS NOT NULL AND horse_code!=''`,
        )
        .bind(now, race.meeting_date, race.venue, race.race_no, horseNo)
        .run();
      cleared_cloth_collision += upd.meta?.changes ?? 0;
    }
  }

  // 3) Name mismatch: runner.name_en vs odds entry for same brand code
  let cleared_name_mismatch = 0;
  let codedSql = `SELECT meeting_date, venue, race_no, horse_no, horse_code, name_en
                  FROM runners
                  WHERE horse_code IS NOT NULL AND horse_code!='' AND name_en IS NOT NULL`;
  const codedBinds: string[] = [];
  if (filter?.date) {
    codedSql += ` AND meeting_date=?`;
    codedBinds.push(filter.date);
  }
  if (filter?.venue) {
    codedSql += ` AND venue=?`;
    codedBinds.push(filter.venue);
  }
  const { results: coded } = await db
    .prepare(codedSql)
    .bind(...codedBinds)
    .all<{
      meeting_date: string;
      venue: string;
      race_no: number;
      horse_no: number;
      horse_code: string;
      name_en: string;
    }>();

  for (const row of coded ?? []) {
    const snap = await db
      .prepare(
        `SELECT raw_json FROM odds_snapshots
         WHERE meeting_date=? AND venue=? AND race_no=?
         ORDER BY snapshot_time DESC, id DESC LIMIT 1`,
      )
      .bind(row.meeting_date, row.venue, row.race_no)
      .first<{ raw_json: string }>();
    if (!snap?.raw_json) continue;
    let runners: Array<{
      horse_code?: string | null;
      runner_id?: string | null;
      horse_name?: string | null;
    }> = [];
    try {
      runners = (JSON.parse(snap.raw_json) as { runners?: typeof runners }).runners ?? [];
    } catch {
      continue;
    }
    const oddsNames = runners
      .filter(
        (r) =>
          horseCodeFromRunnerFields({
            horse_code: r.horse_code,
            runner_id: r.runner_id,
          }) === row.horse_code,
      )
      .map((r) => normalizeHorseName(r.horse_name))
      .filter((n): n is string => n != null);
    if (oddsNames.length === 0) continue;
    const runnerName = normalizeHorseName(row.name_en);
    if (runnerName && !oddsNames.includes(runnerName)) {
      const upd = await db
        .prepare(
          `UPDATE runners SET horse_code=NULL, updated_at=?
           WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?`,
        )
        .bind(
          now,
          row.meeting_date,
          row.venue,
          row.race_no,
          row.horse_no,
        )
        .run();
      cleared_name_mismatch += upd.meta?.changes ?? 0;
    }
  }

  // Keep results.horse_code in sync for cleared runners
  await db
    .prepare(
      `UPDATE results SET horse_code=NULL
       WHERE horse_code IS NOT NULL AND horse_code!=''
         AND EXISTS (
           SELECT 1 FROM runners r
           WHERE r.meeting_date=results.meeting_date AND r.venue=results.venue
             AND r.race_no=results.race_no AND r.horse_no=results.horse_no
             AND (r.horse_code IS NULL OR r.horse_code='')
         )`,
    )
    .run();

  return {
    cleared_standby,
    cleared_cloth_collision,
    cleared_name_mismatch,
    cleared_total: cleared_standby + cleared_cloth_collision + cleared_name_mismatch,
  };
}

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
  let skipped_ambiguous = 0;

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
      const out = await applyFromMeetingRaw(
        db,
        row.meeting_date,
        row.venue,
        row.raw_json,
      );
      from_meetings_raw += out.updated;
      skipped_ambiguous += out.skipped;
    }
  }

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
    binds.push(limit * 12);
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
      const out = await applyFromOddsSnapshot(
        db,
        race.meeting_date,
        race.venue,
        race.race_no,
        snap.raw_json,
      );
      from_odds_snapshots += out.updated;
      skipped_ambiguous += out.skipped;
    }
  }

  return {
    meetings_scanned,
    races_from_odds,
    runners_updated: from_meetings_raw + from_odds_snapshots,
    from_meetings_raw,
    from_odds_snapshots,
    skipped_ambiguous,
  };
}

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

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
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
        ) ??
        res.data?.raceMeetings?.[0] ??
        null;

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
      // After tree write, re-apply identity-safe codes from the FULL raw
      // (handles Declared/Standby cloth collision via name match).
      await applyFromMeetingRaw(
        env.DB,
        m.meeting_date,
        m.venue,
        JSON.stringify(found),
      );
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

  if (opts?.reset_ambiguous && !d1_degraded) {
    result.reset = await resetAmbiguousHorseCodes(env.DB, {
      date: opts.date,
      venue: opts.venue,
    });
    notes.push(
      "reset_ambiguous: cleared Standby / cloth-collision / name-mismatch horse_codes",
    );
  }

  if (source === "store" || source === "both") {
    if (!d1_degraded) {
      result.store = await backfillHorseCodesFromStore(env.DB, {
        limitMeetings: limit,
        date: opts?.date,
        venue: opts?.venue,
      });
      notes.push(
        "store: match by name_en (or unique non-Standby horse_no); never horse_no alone across Declared+Standby",
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

/** @deprecated — prefer runHorseCodeBackfill. */
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
