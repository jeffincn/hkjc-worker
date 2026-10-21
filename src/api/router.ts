import type { Env } from "../env";
import {
  BARRIER_INTEGRITY_META_KEY,
  barrierIntegrityPayload,
  checkBarrierIntegrity,
} from "../parse/barrier-integrity";
import { horseCodeFromRunnerFields } from "../parse/horse-code";
import { getMeta, syncBarrierIntegrityForMeeting } from "../store/db";
import { jsonError, jsonOk, requireBearer } from "./auth";

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "GET" && path === "/health") {
    return handleHealth(env);
  }

  // Admin/control endpoints (also Bearer-protected)
  if (request.method === "POST" && path === "/v1/admin/ingest") {
    const authErr = requireBearer(request, env);
    if (authErr) return authErr;
    const { ingestActiveMeeting } = await import("../services/ingest");
    const result = await ingestActiveMeeting(env);
    return jsonOk(result);
  }

  if (request.method === "POST" && path === "/v1/admin/backfill") {
    const authErr = requireBearer(request, env);
    if (authErr) return authErr;
    const { runBackfillStep } = await import("../backfill/runner");
    const body = (await request.json().catch(() => ({}))) as { limit?: number };
    const result = await runBackfillStep(env, { limit: body.limit ?? 5 });
    return jsonOk(result);
  }

  if (request.method === "POST" && path === "/v1/admin/backfill-horse-codes") {
    const authErr = requireBearer(request, env);
    if (authErr) return authErr;
    const { runHorseCodeBackfill } = await import("../services/horse-code-backfill");
    const body = (await request.json().catch(() => ({}))) as {
      source?: "store" | "hkjc" | "both";
      limit_meetings?: number;
      date?: string;
      venue?: string;
      hkjc_delay_ms?: number;
      /** Clear Standby / cloth-collision / name-mismatch codes before backfill. */
      reset_ambiguous?: boolean;
    };
    const result = await runHorseCodeBackfill(env, {
      source: body.source ?? "store",
      limit_meetings: body.limit_meetings,
      date: body.date,
      venue: body.venue,
      hkjc_delay_ms: body.hkjc_delay_ms,
      reset_ambiguous: body.reset_ambiguous === true,
    });
    return jsonOk(result);
  }

  if (request.method === "POST" && path === "/v1/admin/reset-ambiguous-horse-codes") {
    const authErr = requireBearer(request, env);
    if (authErr) return authErr;
    const { resetAmbiguousHorseCodes } = await import("../services/horse-code-backfill");
    const body = (await request.json().catch(() => ({}))) as {
      date?: string;
      venue?: string;
    };
    const result = await resetAmbiguousHorseCodes(env.DB, {
      date: body.date,
      venue: body.venue,
    });
    return jsonOk(result);
  }

  if (request.method === "POST" && path === "/v1/admin/test-push") {
    const authErr = requireBearer(request, env);
    if (authErr) return authErr;
    const { sendTestPush } = await import("../services/ingest");
    const result = await sendTestPush(env);
    return jsonOk(result);
  }

  // Subscriber admin CRUD
  if (path === "/v1/admin/subscribers") {
    const authErr = requireBearer(request, env);
    if (authErr) return authErr;
    if (request.method === "GET") return listPushSubscribers(env);
    if (request.method === "POST") return createPushSubscriber(request, env);
    return jsonError(405, "Method not allowed");
  }

  const subscriberMatch = /^\/v1\/admin\/subscribers\/(\d+)$/.exec(path);
  if (subscriberMatch) {
    const authErr = requireBearer(request, env);
    if (authErr) return authErr;
    const id = Number(subscriberMatch[1]);
    if (request.method === "PATCH") return updatePushSubscriber(request, env, id);
    if (request.method === "DELETE") return deletePushSubscriber(env, id);
    return jsonError(405, "Method not allowed");
  }

  if (request.method !== "GET") {
    return jsonError(405, "Method not allowed");
  }

  const authErr = requireBearer(request, env);
  if (authErr) return authErr;

  // Resolve brand code by meeting placement (before /v1/horses/:code)
  if (path === "/v1/horses/resolve") {
    return resolveHorseCode(env, url);
  }

  // /v1/horses/:code[/runs|/injuries]
  const horseMatch = /^\/v1\/horses\/([^/]+)(?:\/(runs|injuries))?$/.exec(path);
  if (horseMatch) {
    const code = decodeURIComponent(horseMatch[1]).toUpperCase();
    const sub = horseMatch[2];
    if (!sub) return getHorse(env, code);
    if (sub === "runs") return getHorseRuns(env, code);
    if (sub === "injuries") return getHorseInjuries(env, code);
  }

  // /v1/events/:event_id
  const eventMatch = /^\/v1\/events\/([^/]+)$/.exec(path);
  if (eventMatch) {
    return getPushEvent(env, decodeURIComponent(eventMatch[1]));
  }

  switch (path) {
    case "/v1/meetings":
      return listMeetings(env, url);
    case "/v1/races":
      return listRaces(env, url);
    case "/v1/odds/latest":
      return latestOdds(env, url);
    case "/v1/odds/history":
      return oddsHistory(env, url);
    case "/v1/odds/coverage":
      return oddsCoverage(env, url);
    case "/v1/results":
      return listResults(env, url);
    case "/v1/changes":
      return listChanges(env, url);
    case "/v1/events":
      return listPushEventsApi(env, url);
    default:
      return jsonError(404, "Not found");
  }
}

async function handleHealth(env: Env): Promise<Response> {
  const lastFetch = await getMeta(env.DB, "last_fetch_at");
  const lastPush = await getMeta(env.DB, "last_push_at");
  const lastPushStatus = await getMeta(env.DB, "last_push_status");
  const whitelistAlert = await getMeta(env.DB, "whitelist_error");
  const backfillRange = await env.DB.prepare(
    `SELECT MIN(meeting_date) AS min_date, MAX(meeting_date) AS max_date, COUNT(*) AS n
     FROM backfill_progress WHERE status='done'`,
  ).first<{ min_date: string | null; max_date: string | null; n: number }>();

  // NOTE: /health must stay read-cheap. COUNT(*) over meetings / odds_snapshots
  // is a full table scan on every call and burns the D1 free-tier daily
  // row-read quota on race days (2026-10-11 outage). Totals are intentionally
  // omitted here; use the query endpoints with bounded filters instead.
  // Prefer newest push_log row for last_push_* (any event type).
  const lastPushRow = await env.DB.prepare(
    `SELECT event_type, http_status, success, error_message, sent_at FROM push_log ORDER BY id DESC LIMIT 1`,
  ).first<{
    event_type: string;
    http_status: number | null;
    success: number;
    error_message: string | null;
    sent_at: string;
  }>();

  const effectiveLastPushAt = lastPushRow?.sent_at ?? lastPush;
  const effectiveLastPushStatus =
    lastPushRow != null
      ? lastPushRow.success
        ? String(lastPushRow.http_status)
        : lastPushRow.error_message ?? String(lastPushRow.http_status)
      : lastPushStatus;

  const { listCircuitSnapshots } = await import("../push/circuit");
  const { getQueueBacklog, hasPushQueue } = await import("../push/queue");
  const { readStageErrors } = await import("../util/stage");

  const circuits = await listCircuitSnapshots(env);
  const queue_backlog = await getQueueBacklog(env);
  const stage_errors = await readStageErrors(env, [
    "schedule",
    "odds",
    "dividends",
    "horses",
    "runs",
    "injuries",
    "pushes",
    "changes",
    "persist",
    "wake_do",
    "retry_flush",
    "backfill",
    "watchdog",
  ]);

  let poller: {
    last_fetch_at: string | null;
    age_ms: number | null;
    watchdog_last_run: string | null;
    watchdog_last_rearm: string | null;
  } = {
    last_fetch_at: lastFetch,
    age_ms: lastFetch ? Date.now() - Date.parse(lastFetch) : null,
    watchdog_last_run: await getMeta(env.DB, "poller_watchdog_last_run"),
    watchdog_last_rearm: await getMeta(env.DB, "poller_watchdog_last_rearm"),
  };
  // Prefer DO status when we can cheaply probe a known live meeting from meta.
  try {
    const rearmRaw = poller.watchdog_last_rearm;
    if (rearmRaw) {
      const parsed = JSON.parse(rearmRaw) as { meeting_date?: string; venue?: string };
      if (parsed.meeting_date && parsed.venue) {
        const id = env.MEETING_DO.idFromName(`${parsed.meeting_date}_${parsed.venue}`);
        const stub = env.MEETING_DO.get(id);
        const statusRes = await stub.fetch("https://do/status");
        const status = (await statusRes.json()) as { last_fetch_at?: string | null };
        if (status.last_fetch_at) {
          poller = {
            ...poller,
            last_fetch_at: status.last_fetch_at,
            age_ms: Date.now() - Date.parse(status.last_fetch_at),
          };
        }
      }
    }
  } catch {
    // DO probe is best-effort
  }

  const { countPendingPushStats } = await import("../push/pusher");
  const { getTotalRateLimitDelays } = await import("../push/rate-limit");
  const pendingStats = await countPendingPushStats(env);
  const rate_limit_delays = await getTotalRateLimitDelays(env);

  const { hkDay, resolveDailyRequestBudget, resolvePollIntervalMs, HEALTHY_BLOCK_STATE } =
    await import("../poll/live");
  const { getGraphqlUsage } = await import("../store/usage");
  const usageDay = hkDay(Date.now());
  let graphqlToday = 0;
  try {
    graphqlToday = await getGraphqlUsage(env.DB, usageDay);
  } catch {
    // table may not exist before migration 0007
  }
  let sourceBlock: unknown = HEALTHY_BLOCK_STATE;
  try {
    const raw = await getMeta(env.DB, "source_block_state");
    if (raw) sourceBlock = JSON.parse(raw);
  } catch {
    // ignore
  }
  const dailyBudget = resolveDailyRequestBudget(env);

  const { getD1WriteStats } = await import("../store/d1-budget");
  let d1_writes: {
    day: string;
    today: number;
    budget: number;
    remaining: number;
    degrade: boolean;
  } = {
    day: new Date().toISOString().slice(0, 10),
    today: 0,
    budget: 40_000_000,
    remaining: 40_000_000,
    degrade: false,
  };
  try {
    const stats = await getD1WriteStats(env);
    d1_writes = {
      day: stats.day,
      today: stats.today,
      budget: stats.budget,
      remaining: stats.remaining,
      degrade: stats.degrade,
    };
  } catch {
    // worker_meta / counter may be unavailable
  }

  // Odds poll coverage gaps (>10 min) — cheap meta read, not a table scan.
  const { POLL_GAP_META_KEY, POLL_GAP_THRESHOLD_MS } = await import(
    "../store/poll-ticks"
  );
  let odds_coverage_gap: unknown = null;
  try {
    const raw = await getMeta(env.DB, POLL_GAP_META_KEY);
    if (raw) odds_coverage_gap = JSON.parse(raw);
  } catch {
    // ignore
  }

  // Barrier integrity violations (issue #33) — cheap meta read.
  // Kept in sync by persistMeetingTree, live poll hash-no-op sync, and /v1/races.
  let barrier_integrity_violations: unknown = [];
  try {
    const raw = await getMeta(env.DB, BARRIER_INTEGRITY_META_KEY);
    if (raw) barrier_integrity_violations = JSON.parse(raw);
  } catch {
    barrier_integrity_violations = [];
  }

  return jsonOk({
    ok: true,
    service: "hkjc-data-worker",
    poll_interval_ms: resolvePollIntervalMs(env),
    graphql_requests: {
      day: usageDay,
      /** D1-flushed count (pollers flush at most every 60s). */
      today: graphqlToday,
      daily_budget: dailyBudget,
      remaining: Math.max(0, dailyBudget - graphqlToday),
    },
    d1_writes,
    source_block: sourceBlock,
    timezone: env.TIMEZONE ?? "Asia/Hong_Kong",
    live_push_enabled: env.LIVE_PUSH_ENABLED ?? "false",
    backfill_days: env.BACKFILL_DAYS ?? "60",
    backfill_source: env.BACKFILL_SOURCE ?? "graphql",
    last_fetch_at: lastFetch,
    last_push_at: effectiveLastPushAt,
    last_push_status: effectiveLastPushStatus,
    last_push: lastPushRow ?? null,
    push_queue: {
      bound: hasPushQueue(env),
      backlog: queue_backlog,
      pending_pushes: pendingStats.active,
      pending_due: pendingStats.due,
      pending_deferred: pendingStats.deferred,
      gave_up: pendingStats.gave_up,
      /** Cumulative per-subscriber rate-limit delays (delayed, not dropped). */
      rate_limit_delays,
    },
    subscribers: circuits,
    poller,
    stage_errors,
    backfill: {
      completed_meetings: backfillRange?.n ?? 0,
      from: backfillRange?.min_date ?? null,
      to: backfillRange?.max_date ?? null,
    },
    gaps: {
      note:
        "GraphQL raceMeetings ignores past dates (live only). Backfill uses rbcMeeting (~2 months): has race/runner status + dividends; horse names, finalPosition, win/place odds are null.",
      place_odds_in_backfill: null,
      final_position_in_backfill: null,
      horse_names_in_backfill: null,
      history_beyond_rbc_window: "unavailable via GraphQL",
      /** Live poll presence gaps from poll_ticks (issue #26). */
      odds_coverage_threshold_ms: POLL_GAP_THRESHOLD_MS,
      odds_coverage: odds_coverage_gap,
      /** Barrier duplicate / OOB / null among declared (issue #33). */
      barrier_integrity_violations,
    },
    alerts: {
      whitelist_error: whitelistAlert,
      odds_coverage_gap,
      barrier_integrity_violations,
    },
  });
}

async function listMeetings(env: Env, url: URL): Promise<Response> {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  let sql = `SELECT meeting_date, venue, total_races, status, data_source, updated_at FROM meetings WHERE 1=1`;
  const binds: string[] = [];
  if (from) {
    sql += ` AND meeting_date >= ?`;
    binds.push(from);
  }
  if (to) {
    sql += ` AND meeting_date <= ?`;
    binds.push(to);
  }
  sql += ` ORDER BY meeting_date DESC, venue ASC`;
  const stmt = env.DB.prepare(sql);
  const { results } = await (binds.length ? stmt.bind(...binds) : stmt).all();
  return jsonOk({ meetings: results ?? [] });
}

/**
 * Map cloth → brand code for Declared runners only.
 * Never use for Standby — same cloth can belong to a different horse.
 */
async function horseCodeByCloth(
  env: Env,
  date: string,
  venue: string,
  raceNo: number,
): Promise<Map<number, string>> {
  const { results } = await env.DB.prepare(
    `SELECT horse_no, horse_code FROM runners
     WHERE meeting_date=? AND venue=? AND race_no=?
       AND horse_code IS NOT NULL AND horse_code!=''
       AND upper(coalesce(status,'')) NOT LIKE '%STANDBY%'`,
  )
    .bind(date, venue, raceNo)
    .all<{ horse_no: number; horse_code: string }>();
  const map = new Map<number, string>();
  for (const r of results ?? []) {
    if (r.horse_code) map.set(r.horse_no, r.horse_code);
  }
  return map;
}

function enrichOddsDataRunners(
  data: unknown,
  codeByCloth: Map<number, string>,
): unknown {
  if (!data || typeof data !== "object") return data;
  const snap = data as {
    runners?: Array<
      Record<string, unknown> & {
        horse_no?: number;
        runner_id?: string;
        horse_code?: string | null;
        status?: string | null;
      }
    >;
  };
  if (!Array.isArray(snap.runners)) return data;
  return {
    ...snap,
    runners: snap.runners.map((r) => {
      const status = typeof r.status === "string" ? r.status : "";
      const standby = status.toUpperCase().includes("STANDBY");
      // Prefer runner_id / explicit horse_code; cloth map only for Declared.
      const fromCloth =
        !standby && r.horse_no != null
          ? (codeByCloth.get(Number(r.horse_no)) ?? null)
          : null;
      const horse_code =
        horseCodeFromRunnerFields({
          horse_code: (r.horse_code as string | null | undefined) ?? null,
          runner_id: (r.runner_id as string | null | undefined) ?? null,
        }) ?? fromCloth;
      return { ...r, horse_code };
    }),
  };
}

async function listRaces(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const venue = url.searchParams.get("venue");
  if (!date || !venue) return jsonError(400, "date and venue required");
  const { results: races } = await env.DB.prepare(
    `SELECT meeting_date, venue, race_no, post_time, status, distance, going, course_desc, course_code, race_class, data_source, updated_at
     FROM races WHERE meeting_date=? AND venue=? ORDER BY race_no`,
  )
    .bind(date, venue)
    .all();
  const { results: runners } = await env.DB.prepare(
    `SELECT race_no, horse_no, horse_code, name_en, name_ch, status, barrier, handicap_weight,
            jockey_en, trainer_en, last6run, data_source, updated_at
     FROM runners WHERE meeting_date=? AND venue=? ORDER BY race_no, horse_no`,
  )
    .bind(date, venue)
    .all<{
      race_no: number;
      horse_no: number;
      horse_code: string | null;
      name_en: string | null;
      name_ch: string | null;
      status: string | null;
      barrier: number | null;
      handicap_weight: number | null;
      jockey_en: string | null;
      trainer_en: string | null;
      last6run: string | null;
      data_source: string;
      updated_at: string;
    }>();
  const byRace = new Map<number, typeof runners>();
  for (const r of runners ?? []) {
    const list = byRace.get(r.race_no) ?? [];
    list.push(r);
    byRace.set(r.race_no, list);
  }

  const raceViews = (races ?? []).map((race) => {
    const raceNo = (race as { race_no: number }).race_no;
    const raceRunners = byRace.get(raceNo) ?? [];
    const integrity = checkBarrierIntegrity(raceRunners);
    return {
      race,
      raceNo,
      raceRunners,
      integrity,
    };
  });

  // Keep /health meta aligned with this live check (tree-hash may skip persist).
  try {
    await syncBarrierIntegrityForMeeting(
      env.DB,
      date,
      venue,
      raceViews.map((r) => ({
        race_no: r.raceNo,
        runners: r.raceRunners,
      })),
    );
  } catch {
    // meta sync must not break the races query
  }

  return jsonOk({
    date,
    venue,
    races: raceViews.map(({ race, raceRunners, integrity }) => ({
      ...race,
      /** True on duplicate / out-of-range / null barrier among declared (issue #33). */
      barrier_unreliable: integrity.barrier_unreliable,
      barrier_integrity: barrierIntegrityPayload(integrity),
      runners: raceRunners.map((r) => ({
        horse_no: r.horse_no,
        horse_code: r.horse_code,
        name_en: r.name_en,
        name_ch: r.name_ch,
        status: r.status,
        barrier: r.barrier,
        handicap_weight: r.handicap_weight,
        jockey_en: r.jockey_en,
        trainer_en: r.trainer_en,
        last6run: r.last6run,
      })),
    })),
  });
}

async function latestOdds(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const venue = url.searchParams.get("venue");
  const raceNo = url.searchParams.get("race_no");
  if (!date || !venue || !raceNo) return jsonError(400, "date, venue, race_no required");
  const n = Number(raceNo);
  const row = await env.DB.prepare(
    `SELECT snapshot_time, content_hash, pool_status, raw_json, data_source, created_at
     FROM odds_snapshots WHERE meeting_date=? AND venue=? AND race_no=?
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(date, venue, n)
    .first<{
      snapshot_time: string;
      content_hash: string;
      pool_status: string | null;
      raw_json: string;
      data_source: string;
      created_at: string;
    }>();
  if (!row) return jsonOk({ date, venue, race_no: n, snapshot: null });
  const codeByCloth = await horseCodeByCloth(env, date, venue, n);
  return jsonOk({
    date,
    venue,
    race_no: n,
    snapshot: {
      snapshot_time: row.snapshot_time,
      content_hash: row.content_hash,
      pool_status: row.pool_status,
      data_source: row.data_source,
      created_at: row.created_at,
      data: enrichOddsDataRunners(JSON.parse(row.raw_json), codeByCloth),
    },
  });
}

async function oddsHistory(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const venue = url.searchParams.get("venue");
  const raceNo = url.searchParams.get("race_no");
  if (!date || !venue || !raceNo) return jsonError(400, "date, venue, race_no required");
  const n = Number(raceNo);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if ((from && !to) || (!from && to)) {
    return jsonError(400, "from and to must be provided together (ISO time_range)");
  }
  const { results } = await env.DB.prepare(
    `SELECT snapshot_time, content_hash, pool_status, raw_json, data_source, created_at
     FROM odds_snapshots WHERE meeting_date=? AND venue=? AND race_no=?
     ORDER BY id ASC`,
  )
    .bind(date, venue, n)
    .all<{
      snapshot_time: string;
      content_hash: string;
      pool_status: string | null;
      raw_json: string;
      data_source: string;
      created_at: string;
    }>();
  const codeByCloth = await horseCodeByCloth(env, date, venue, n);
  const { loadRaceCoverage, answerCoverageForRange } = await import(
    "../store/poll-ticks"
  );
  const coverage = await loadRaceCoverage({
    db: env.DB,
    meeting_date: date,
    venue,
    race_no: n,
    from,
    to,
  });
  // A2: for any (race, time_range) answer STATIC vs MISSING.
  let range: {
    kind: "STATIC" | "MISSING";
    from: string;
    to: string;
  } | null = null;
  if (from && to) {
    const ans = answerCoverageForRange({
      ticks: coverage.ticks,
      from,
      to,
    });
    range = { kind: ans.kind, from: ans.from, to: ans.to };
  }
  return jsonOk({
    date,
    venue,
    race_no: n,
    snapshots: (results ?? []).map((r) => ({
      snapshot_time: r.snapshot_time,
      content_hash: r.content_hash,
      pool_status: r.pool_status,
      data_source: r.data_source,
      created_at: r.created_at,
      data: enrichOddsDataRunners(JSON.parse(r.raw_json), codeByCloth),
    })),
    /** Poll presence: STATIC vs MISSING (issue #26 A2). */
    coverage: {
      gap_threshold_ms: coverage.gap_threshold_ms,
      gaps: coverage.gaps,
      intervals: coverage.intervals,
      tick_count: coverage.ticks.length,
      /** Present when `from`+`to` query params set — A2 answer. */
      range,
    },
  });
}

/** Poll presence / coverage for one race (or all races when race_no omitted). */
async function oddsCoverage(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const venue = url.searchParams.get("venue");
  const raceNo = url.searchParams.get("race_no");
  if (!date || !venue) return jsonError(400, "date and venue required");

  const {
    listPollTicks,
    loadRaceCoverage,
    detectGapsForRace,
    buildCoverageIntervals,
    POLL_GAP_THRESHOLD_MS,
  } = await import("../store/poll-ticks");

  if (raceNo != null && raceNo !== "") {
    const n = Number(raceNo);
    if (!Number.isFinite(n) || n <= 0) {
      return jsonError(400, "race_no must be a positive number");
    }
    const coverage = await loadRaceCoverage({
      db: env.DB,
      meeting_date: date,
      venue,
      race_no: n,
    });
    return jsonOk({
      date,
      venue,
      race_no: n,
      gap_threshold_ms: coverage.gap_threshold_ms,
      ticks: coverage.ticks,
      gaps: coverage.gaps,
      intervals: coverage.intervals,
    });
  }

  const ticks = await listPollTicks(env.DB, date, venue);
  const byRace = new Map<number, typeof ticks>();
  for (const t of ticks) {
    const list = byRace.get(t.race_no) ?? [];
    list.push(t);
    byRace.set(t.race_no, list);
  }
  const races = [...byRace.keys()].sort((a, b) => a - b).map((race_no) => {
    const raceTicks = byRace.get(race_no) ?? [];
    return {
      race_no,
      tick_count: raceTicks.length,
      gaps: detectGapsForRace({ race_no, ticks: raceTicks }),
      intervals: buildCoverageIntervals({ ticks: raceTicks }),
    };
  });
  return jsonOk({
    date,
    venue,
    gap_threshold_ms: POLL_GAP_THRESHOLD_MS,
    races,
  });
}

async function listResults(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const venue = url.searchParams.get("venue");
  if (!date || !venue) return jsonError(400, "date and venue required");
  const { results } = await env.DB.prepare(
    `SELECT r.meeting_date, r.venue, r.race_no, r.horse_no,
            COALESCE(r.horse_code, u.horse_code) AS horse_code,
            r.final_position, r.dead_heat, r.win_odds, r.place_odds,
            r.dividends_json, r.data_source, r.updated_at
     FROM results r
     LEFT JOIN runners u
       ON u.meeting_date=r.meeting_date AND u.venue=r.venue
      AND u.race_no=r.race_no AND u.horse_no=r.horse_no
     WHERE r.meeting_date=? AND r.venue=?
     ORDER BY r.race_no, r.horse_no`,
  )
    .bind(date, venue)
    .all();
  return jsonOk({
    date,
    venue,
    results: (results ?? []).map((r) => ({
      ...r,
      dividends: r.dividends_json ? JSON.parse(r.dividends_json as string) : null,
      dividends_json: undefined,
    })),
  });
}

/** Cheap D1 lookup: date+venue+race_no+horse_no → horse_code. */
async function resolveHorseCode(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const venue = url.searchParams.get("venue");
  const raceNo = url.searchParams.get("race_no");
  const horseNo = url.searchParams.get("horse_no");
  if (!date || !venue || !raceNo || !horseNo) {
    return jsonError(400, "date, venue, race_no, horse_no required");
  }
  const row = await env.DB.prepare(
    `SELECT horse_code, name_en, name_ch FROM runners
     WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?`,
  )
    .bind(date, venue, Number(raceNo), Number(horseNo))
    .first<{ horse_code: string | null; name_en: string | null; name_ch: string | null }>();
  if (!row) return jsonError(404, "Runner not found");
  return jsonOk({
    date,
    venue,
    race_no: Number(raceNo),
    horse_no: Number(horseNo),
    horse_code: row.horse_code,
    name_en: row.name_en,
    name_ch: row.name_ch,
  });
}

async function getHorse(env: Env, code: string): Promise<Response> {
  // Primary key is horse_code; also accept horse_id (e.g. HK_2022_H087).
  let row = await env.DB.prepare(
    `SELECT * FROM horses WHERE horse_code=? OR upper(horse_id)=upper(?) LIMIT 1`,
  )
    .bind(code, code)
    .first();
  if (!row) {
    // Fallback: brand code seen on runners but HTML profile not fetched yet.
    const fromRunner = await env.DB.prepare(
      `SELECT horse_code, name_en, name_ch FROM runners
       WHERE horse_code=? LIMIT 1`,
    )
      .bind(code)
      .first<{ horse_code: string; name_en: string | null; name_ch: string | null }>();
    if (!fromRunner) return jsonError(404, "Horse not found");
    row = {
      horse_code: fromRunner.horse_code,
      horse_id: null,
      name_en: fromRunner.name_en,
      name_ch: fromRunner.name_ch,
      data_source: "runners",
      fetched_at: null,
      updated_at: null,
    };
  }
  return jsonOk({ horse: row });
}

async function getHorseRuns(env: Env, code: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT race_index, placing, race_date, venue, track, course, distance, going, race_class,
            draw, rating, trainer, jockey, lbw, win_odds, actual_weight, running_position,
            finish_time, declared_weight, gear, data_source, source_url, content_hash, fetched_at
     FROM horse_past_runs WHERE horse_code=? ORDER BY race_date DESC, race_index DESC`,
  )
    .bind(code)
    .all();
  return jsonOk({ horse_code: code, runs: results ?? [] });
}

async function getHorseInjuries(env: Env, code: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT horse_code, horse_name, meeting_date, venue, record_date, details, passed_on,
            data_source, source_url, content_hash, fetched_at
     FROM horse_injuries WHERE horse_code=? OR horse_name IN (
       SELECT name_en FROM horses WHERE horse_code=?
     ) ORDER BY record_date DESC`,
  )
    .bind(code, code)
    .all();
  return jsonOk({ horse_code: code, injuries: results ?? [] });
}

async function listPushSubscribers(env: Env): Promise<Response> {
  const {
    listSubscribers,
    toPublicSubscriber,
  } = await import("../push/subscribers");
  const rows = await listSubscribers(env);
  return jsonOk({ subscribers: rows.map(toPublicSubscriber) });
}

async function createPushSubscriber(request: Request, env: Env): Promise<Response> {
  const {
    createSubscriber,
    toPublicSubscriber,
  } = await import("../push/subscribers");
  const body = (await request.json().catch(() => null)) as {
    url?: string;
    secret?: string | null;
    enabled?: boolean;
    active_window?: string;
    window_before_sec?: number;
    quiet_start?: string | null;
    quiet_end?: string | null;
  } | null;
  if (!body || typeof body.url !== "string") {
    return jsonError(400, "url is required");
  }
  try {
    const row = await createSubscriber(env, {
      url: body.url,
      secret: body.secret,
      enabled: body.enabled,
      active_window: body.active_window,
      window_before_sec: body.window_before_sec,
      quiet_start: body.quiet_start,
      quiet_end: body.quiet_end,
    });
    return jsonOk({ subscriber: toPublicSubscriber(row) }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.toLowerCase().includes("unique")) {
      return jsonError(409, "subscriber url already exists");
    }
    return jsonError(400, msg);
  }
}

async function updatePushSubscriber(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  const {
    updateSubscriber,
    toPublicSubscriber,
  } = await import("../push/subscribers");
  const body = (await request.json().catch(() => null)) as {
    url?: string;
    secret?: string | null;
    enabled?: boolean;
    active_window?: string;
    window_before_sec?: number;
    quiet_start?: string | null;
    quiet_end?: string | null;
  } | null;
  if (!body || typeof body !== "object") {
    return jsonError(400, "JSON body required");
  }
  try {
    const row = await updateSubscriber(env, id, body);
    if (!row) return jsonError(404, "subscriber not found");
    return jsonOk({ subscriber: toPublicSubscriber(row) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.toLowerCase().includes("unique")) {
      return jsonError(409, "subscriber url already exists");
    }
    return jsonError(400, msg);
  }
}

async function deletePushSubscriber(env: Env, id: number): Promise<Response> {
  const { deleteSubscriber } = await import("../push/subscribers");
  const ok = await deleteSubscriber(env, id);
  if (!ok) return jsonError(404, "subscriber not found");
  return jsonOk({ deleted: true, id });
}

async function listPushEventsApi(env: Env, url: URL): Promise<Response> {
  const meeting_date = url.searchParams.get("meeting_date");
  const venue = url.searchParams.get("venue");
  if (!meeting_date || !venue) {
    return jsonError(400, "meeting_date and venue required");
  }
  const sinceRaw = url.searchParams.get("since_seq");
  const limitRaw = url.searchParams.get("limit");
  const since_seq = sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : 0;
  const limit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : 100;
  if (!Number.isFinite(since_seq) || since_seq < 0) {
    return jsonError(400, "since_seq must be a non-negative number");
  }
  if (!Number.isFinite(limit) || limit < 1) {
    return jsonError(400, "limit must be a positive number");
  }
  const { listPushEvents } = await import("../push/ledger");
  const events = await listPushEvents(env, {
    meeting_date,
    venue,
    since_seq,
    limit,
  });
  return jsonOk({
    meeting_date,
    venue,
    since_seq,
    limit: Math.min(Math.max(limit, 1), 500),
    events,
  });
}

async function getPushEvent(env: Env, eventId: string): Promise<Response> {
  const { getPushEventById } = await import("../push/ledger");
  const event = await getPushEventById(env, eventId);
  if (!event) return jsonError(404, "event not found");
  return jsonOk({ event });
}

async function listChanges(env: Env, url: URL): Promise<Response> {
  const since = url.searchParams.get("since");
  if (!since) return jsonError(400, "since required (ISO time)");
  const { results } = await env.DB.prepare(
    `SELECT id, meeting_date, venue, race_no, event_type, payload_json, content_hash, created_at
     FROM change_events WHERE created_at >= ? ORDER BY created_at ASC LIMIT 500`,
  )
    .bind(since)
    .all<{
      id: number;
      meeting_date: string;
      venue: string;
      race_no: number;
      event_type: string;
      payload_json: string;
      content_hash: string;
      created_at: string;
    }>();

  const snaps = await env.DB.prepare(
    `SELECT id, meeting_date, venue, race_no, snapshot_time, content_hash, created_at
     FROM odds_snapshots WHERE created_at >= ? ORDER BY created_at ASC LIMIT 500`,
  )
    .bind(since)
    .all();

  return jsonOk({
    since,
    changes: (results ?? []).map((r) => ({
      ...r,
      payload: JSON.parse(r.payload_json),
      payload_json: undefined,
    })),
    odds_snapshots: snaps.results ?? [],
  });
}
