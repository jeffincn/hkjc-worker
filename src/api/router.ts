import type { Env } from "../env";
import { getMeta } from "../store/db";
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

  if (request.method === "POST" && path === "/v1/admin/test-push") {
    const authErr = requireBearer(request, env);
    if (authErr) return authErr;
    const { sendTestPush } = await import("../services/ingest");
    const result = await sendTestPush(env);
    return jsonOk(result);
  }

  if (request.method !== "GET") {
    return jsonError(405, "Method not allowed");
  }

  const authErr = requireBearer(request, env);
  if (authErr) return authErr;

  // /v1/horses/:code[/runs|/injuries]
  const horseMatch = /^\/v1\/horses\/([^/]+)(?:\/(runs|injuries))?$/.exec(path);
  if (horseMatch) {
    const code = decodeURIComponent(horseMatch[1]).toUpperCase();
    const sub = horseMatch[2];
    if (!sub) return getHorse(env, code);
    if (sub === "runs") return getHorseRuns(env, code);
    if (sub === "injuries") return getHorseInjuries(env, code);
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
    case "/v1/results":
      return listResults(env, url);
    case "/v1/changes":
      return listChanges(env, url);
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

  const meetingCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM meetings`).first<{
    n: number;
  }>();
  const snapshotCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM odds_snapshots`).first<{
    n: number;
  }>();

  const lastPushRow = await env.DB.prepare(
    `SELECT event_type, http_status, success, error_message, sent_at FROM push_log ORDER BY id DESC LIMIT 1`,
  ).first();

  return jsonOk({
    ok: true,
    service: "hkjc-data-worker",
    timezone: env.TIMEZONE ?? "Asia/Hong_Kong",
    live_push_enabled: env.LIVE_PUSH_ENABLED ?? "false",
    backfill_days: env.BACKFILL_DAYS ?? "60",
    backfill_source: env.BACKFILL_SOURCE ?? "graphql",
    last_fetch_at: lastFetch,
    last_push_at: lastPush,
    last_push_status: lastPushStatus,
    last_push: lastPushRow ?? null,
    meetings_stored: meetingCount?.n ?? 0,
    odds_snapshots: snapshotCount?.n ?? 0,
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
    },
    alerts: {
      whitelist_error: whitelistAlert,
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

async function listRaces(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const venue = url.searchParams.get("venue");
  if (!date || !venue) return jsonError(400, "date and venue required");
  const { results } = await env.DB.prepare(
    `SELECT meeting_date, venue, race_no, post_time, status, distance, going, course_desc, course_code, race_class, data_source, updated_at
     FROM races WHERE meeting_date=? AND venue=? ORDER BY race_no`,
  )
    .bind(date, venue)
    .all();
  return jsonOk({ date, venue, races: results ?? [] });
}

async function latestOdds(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const venue = url.searchParams.get("venue");
  const raceNo = url.searchParams.get("race_no");
  if (!date || !venue || !raceNo) return jsonError(400, "date, venue, race_no required");
  const row = await env.DB.prepare(
    `SELECT snapshot_time, content_hash, pool_status, raw_json, data_source, created_at
     FROM odds_snapshots WHERE meeting_date=? AND venue=? AND race_no=?
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(date, venue, Number(raceNo))
    .first<{
      snapshot_time: string;
      content_hash: string;
      pool_status: string | null;
      raw_json: string;
      data_source: string;
      created_at: string;
    }>();
  if (!row) return jsonOk({ date, venue, race_no: Number(raceNo), snapshot: null });
  return jsonOk({
    date,
    venue,
    race_no: Number(raceNo),
    snapshot: {
      snapshot_time: row.snapshot_time,
      content_hash: row.content_hash,
      pool_status: row.pool_status,
      data_source: row.data_source,
      created_at: row.created_at,
      data: JSON.parse(row.raw_json),
    },
  });
}

async function oddsHistory(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const venue = url.searchParams.get("venue");
  const raceNo = url.searchParams.get("race_no");
  if (!date || !venue || !raceNo) return jsonError(400, "date, venue, race_no required");
  const { results } = await env.DB.prepare(
    `SELECT snapshot_time, content_hash, pool_status, raw_json, data_source, created_at
     FROM odds_snapshots WHERE meeting_date=? AND venue=? AND race_no=?
     ORDER BY id ASC`,
  )
    .bind(date, venue, Number(raceNo))
    .all<{
      snapshot_time: string;
      content_hash: string;
      pool_status: string | null;
      raw_json: string;
      data_source: string;
      created_at: string;
    }>();
  return jsonOk({
    date,
    venue,
    race_no: Number(raceNo),
    snapshots: (results ?? []).map((r) => ({
      snapshot_time: r.snapshot_time,
      content_hash: r.content_hash,
      pool_status: r.pool_status,
      data_source: r.data_source,
      created_at: r.created_at,
      data: JSON.parse(r.raw_json),
    })),
  });
}

async function listResults(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const venue = url.searchParams.get("venue");
  if (!date || !venue) return jsonError(400, "date and venue required");
  const { results } = await env.DB.prepare(
    `SELECT meeting_date, venue, race_no, horse_no, final_position, dead_heat, win_odds, place_odds, dividends_json, data_source, updated_at
     FROM results WHERE meeting_date=? AND venue=? ORDER BY race_no, horse_no`,
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

async function getHorse(env: Env, code: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT * FROM horses WHERE horse_code=?`).bind(code).first();
  if (!row) return jsonError(404, "Horse not found");
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
