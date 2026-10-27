/**
 * D1 store for issue #50 fundamentals: gear, ratings, trials, weights, rail, Q/QP pools.
 */

import type { Env } from "../env";
import type { BarrierTrialBatch } from "../html/barrier-trial";
import { parseGearItems } from "../html/gear";
import type { HorseProfile, PastRun } from "../html/horse";
import { normalizeCourseCode } from "../html/horse";
import { contentHash } from "../parse/hash";
import { trackD1Result } from "./d1-budget";

function intOrNull(s: string | null | undefined): number | null {
  if (s == null || s === "") return null;
  const n = Number(String(s).replace(/,/g, "").trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Project horse past-performance rows into dedicated fundamentals tables.
 * Idempotent upserts keyed as specified in #50.
 */
export async function upsertFundamentalsFromHorseRuns(
  db: D1Database,
  args: {
    horse_code: string;
    profile: HorseProfile;
    runs: PastRun[];
    source_url: string;
    env?: Env;
  },
): Promise<{
  gear: number;
  ratings: number;
  weights: number;
  rails: number;
}> {
  const now = new Date().toISOString();
  const lastRating = intOrNull(args.profile.last_rating);
  let gear = 0;
  let ratings = 0;
  let weights = 0;
  let rails = 0;

  // Chronological for rating_change (oldest → newest)
  const chrono = [...args.runs]
    .filter((r) => r.race_date)
    .sort((a, b) => {
      const d = String(a.race_date).localeCompare(String(b.race_date));
      if (d !== 0) return d;
      return String(a.race_index ?? "").localeCompare(String(b.race_index ?? ""));
    });

  let prevRating: number | null = null;
  for (const run of chrono) {
    const race_index = run.race_index ?? "";
    const race_date = run.race_date!;
    const course = normalizeCourseCode(run.course);

    if (run.gear) {
      const items = parseGearItems(run.gear);
      const hash = await contentHash({
        horse_code: args.horse_code,
        race_date,
        race_index,
        gear: run.gear,
        items,
      });
      const result = await db
        .prepare(
          `INSERT INTO gear_changes (
             horse_code, race_date, race_index, venue, race_no, track, course,
             gear_raw, gear_items_json, data_source, source_url, content_hash, scraped_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'html_horse', ?, ?, ?)
           ON CONFLICT(horse_code, race_date, race_index) DO UPDATE SET
             venue=excluded.venue,
             race_no=COALESCE(excluded.race_no, gear_changes.race_no),
             track=excluded.track,
             course=excluded.course,
             gear_raw=excluded.gear_raw,
             gear_items_json=excluded.gear_items_json,
             source_url=excluded.source_url,
             content_hash=excluded.content_hash,
             scraped_at=excluded.scraped_at`,
        )
        .bind(
          args.horse_code,
          race_date,
          race_index,
          run.venue,
          run.race_no,
          run.track,
          course,
          run.gear,
          JSON.stringify(items),
          args.source_url,
          hash,
          now,
        )
        .run();
      if (args.env) await trackD1Result(args.env, result);
      gear++;
    }

    const rating = intOrNull(run.rating);
    if (rating != null) {
      const rating_change =
        prevRating != null ? rating - prevRating : null;
      const hash = await contentHash({
        horse_code: args.horse_code,
        race_date,
        race_index,
        rating,
        rating_change,
        last_rating: lastRating,
      });
      const result = await db
        .prepare(
          `INSERT INTO official_ratings (
             horse_code, race_date, race_index, venue, race_no, rating, rating_change,
             last_rating, data_source, source_url, content_hash, scraped_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'html_horse', ?, ?, ?)
           ON CONFLICT(horse_code, race_date, race_index) DO UPDATE SET
             venue=excluded.venue,
             race_no=COALESCE(excluded.race_no, official_ratings.race_no),
             rating=excluded.rating,
             rating_change=excluded.rating_change,
             last_rating=excluded.last_rating,
             source_url=excluded.source_url,
             content_hash=excluded.content_hash,
             scraped_at=excluded.scraped_at`,
        )
        .bind(
          args.horse_code,
          race_date,
          race_index,
          run.venue,
          run.race_no,
          rating,
          rating_change,
          lastRating,
          args.source_url,
          hash,
          now,
        )
        .run();
      if (args.env) await trackD1Result(args.env, result);
      ratings++;
      prevRating = rating;
    }

    if (run.declared_weight != null) {
      const hash = await contentHash({
        horse_code: args.horse_code,
        race_date,
        race_index,
        declared_weight: run.declared_weight,
      });
      const result = await db
        .prepare(
          `INSERT INTO declared_horse_weights (
             horse_code, race_date, race_index, venue, race_no, declared_weight,
             weight_date, data_source, source_url, content_hash, scraped_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'html_horse', ?, ?, ?)
           ON CONFLICT(horse_code, race_date, race_index) DO UPDATE SET
             venue=excluded.venue,
             race_no=COALESCE(excluded.race_no, declared_horse_weights.race_no),
             declared_weight=excluded.declared_weight,
             source_url=excluded.source_url,
             content_hash=excluded.content_hash,
             scraped_at=excluded.scraped_at`,
        )
        .bind(
          args.horse_code,
          race_date,
          race_index,
          run.venue,
          run.race_no,
          run.declared_weight,
          race_date,
          args.source_url,
          hash,
          now,
        )
        .run();
      if (args.env) await trackD1Result(args.env, result);
      weights++;
    }

    if (run.venue && (course || run.track)) {
      const track = run.track ?? "";
      const hash = await contentHash({
        meeting_date: race_date,
        venue: run.venue,
        track,
        course_code: course,
      });
      const result = await db
        .prepare(
          `INSERT INTO rail_positions (
             meeting_date, venue, track, course_code, course_desc,
             data_source, source_url, content_hash, scraped_at
           ) VALUES (?, ?, ?, ?, ?, 'html_horse', ?, ?, ?)
           ON CONFLICT(meeting_date, venue, track) DO UPDATE SET
             course_code=COALESCE(excluded.course_code, rail_positions.course_code),
             course_desc=COALESCE(excluded.course_desc, rail_positions.course_desc),
             content_hash=excluded.content_hash,
             scraped_at=excluded.scraped_at`,
        )
        .bind(
          race_date,
          run.venue,
          track,
          course,
          course,
          args.source_url,
          hash,
          now,
        )
        .run();
      if (args.env) await trackD1Result(args.env, result);
      rails++;
    }
  }

  return { gear, ratings, weights, rails };
}

export async function upsertRailFromMeeting(
  db: D1Database,
  args: {
    meeting_date: string;
    venue: string;
    races: Array<{
      course_code: string | null;
      course_desc: string | null;
      /** Optional track hint (Turf / AWT) derived from desc. */
      track?: string | null;
    }>;
    data_source?: string;
    env?: Env;
  },
): Promise<number> {
  const now = new Date().toISOString();
  const byTrack = new Map<
    string,
    { course_code: string | null; course_desc: string | null }
  >();

  for (const r of args.races) {
    const code = normalizeCourseCode(r.course_code) ?? normalizeCourseCode(r.course_desc);
    const desc = r.course_desc;
    let track = r.track ?? "";
    if (!track && desc) {
      if (/AWT|All\s*Weather/i.test(desc)) track = "AWT";
      else if (/Turf/i.test(desc)) track = "Turf";
    }
    // Prefer first non-null code per track.
    const prev = byTrack.get(track);
    if (!prev || (!prev.course_code && code)) {
      byTrack.set(track, { course_code: code, course_desc: desc });
    }
  }

  let n = 0;
  for (const [track, v] of byTrack) {
    if (!v.course_code && !v.course_desc) continue;
    const hash = await contentHash({
      meeting_date: args.meeting_date,
      venue: args.venue,
      track,
      course_code: v.course_code,
    });
    const result = await db
      .prepare(
        `INSERT INTO rail_positions (
           meeting_date, venue, track, course_code, course_desc,
           data_source, source_url, content_hash, scraped_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(meeting_date, venue, track) DO UPDATE SET
           course_code=COALESCE(excluded.course_code, rail_positions.course_code),
           course_desc=COALESCE(excluded.course_desc, rail_positions.course_desc),
           data_source=excluded.data_source,
           content_hash=excluded.content_hash,
           scraped_at=excluded.scraped_at`,
      )
      .bind(
        args.meeting_date,
        args.venue,
        track,
        v.course_code,
        v.course_desc,
        args.data_source ?? "graphql",
        hash,
        now,
      )
      .run();
    if (args.env) await trackD1Result(args.env, result);
    n++;
  }
  return n;
}

export async function replaceBarrierTrialDay(
  db: D1Database,
  args: {
    trial_date: string;
    batches: BarrierTrialBatch[];
    source_url: string;
    content_hash: string;
    env?: Env;
  },
): Promise<{ rows: number; changed: boolean }> {
  const now = new Date().toISOString();
  const prev = await db
    .prepare(`SELECT content_hash FROM barrier_trial_ingest_progress WHERE trial_date=?`)
    .bind(args.trial_date)
    .first<{ content_hash: string | null }>();

  if (prev?.content_hash === args.content_hash) {
    return { rows: 0, changed: false };
  }

  await db
    .prepare(`DELETE FROM barrier_trials WHERE trial_date=?`)
    .bind(args.trial_date)
    .run();

  let rows = 0;
  for (const batch of args.batches) {
    for (const h of batch.horses) {
      if (!h.horse_code) continue;
      const result = await db
        .prepare(
          `INSERT OR REPLACE INTO barrier_trials (
             trial_date, batch_no, horse_code, horse_name, venue, track, distance,
             going, batch_time, sectional_times, jockey, trainer, draw, gear, lbw,
             running_position, finish_time, result, comment,
             data_source, source_url, content_hash, scraped_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'html_btresult', ?, ?, ?)`,
        )
        .bind(
          args.trial_date,
          batch.batch_no,
          h.horse_code,
          h.horse_name,
          batch.venue,
          batch.track,
          batch.distance,
          batch.going,
          batch.batch_time,
          batch.sectional_times,
          h.jockey,
          h.trainer,
          h.draw,
          h.gear,
          h.lbw,
          h.running_position,
          h.finish_time,
          h.result,
          h.comment,
          args.source_url,
          args.content_hash,
          now,
        )
        .run();
      if (args.env) await trackD1Result(args.env, result);
      rows++;
    }
  }

  await db
    .prepare(
      `INSERT INTO barrier_trial_ingest_progress (
         trial_date, status, content_hash, source_url, scraped_at, error_message
       ) VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(trial_date) DO UPDATE SET
         status=excluded.status,
         content_hash=excluded.content_hash,
         source_url=excluded.source_url,
         scraped_at=excluded.scraped_at,
         error_message=NULL`,
    )
    .bind(
      args.trial_date,
      rows > 0 ? "done" : "empty",
      args.content_hash,
      args.source_url,
      now,
    )
    .run();

  return { rows, changed: true };
}

export async function upsertGearFromStarterPdf(
  db: D1Database,
  args: {
    meeting_date: string;
    venue: string;
    rows: Array<{
      race_no: number | null;
      horse_no: number | null;
      horse_name: string | null;
      horse_code?: string | null;
      gear_raw: string;
      is_standby?: boolean;
    }>;
    source_url: string;
    env?: Env;
  },
): Promise<number> {
  const now = new Date().toISOString();
  let n = 0;
  for (const row of args.rows) {
    let horse_code = row.horse_code ?? null;
    if (!horse_code && row.race_no != null && row.horse_no != null) {
      const matched = await db
        .prepare(
          `SELECT horse_code FROM runners
           WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?
             AND is_standby=?
           LIMIT 1`,
        )
        .bind(
          args.meeting_date,
          args.venue,
          row.race_no,
          row.horse_no,
          row.is_standby ? 1 : 0,
        )
        .first<{ horse_code: string | null }>();
      horse_code = matched?.horse_code ?? null;
    }
    if (!horse_code && row.horse_name) {
      const byName = await db
        .prepare(
          `SELECT horse_code FROM runners
           WHERE meeting_date=? AND venue=? AND upper(name_en)=upper(?)
           LIMIT 1`,
        )
        .bind(args.meeting_date, args.venue, row.horse_name)
        .first<{ horse_code: string | null }>();
      horse_code = byName?.horse_code ?? null;
    }
    if (!horse_code) continue;

    const race_index = row.race_no != null ? `R${row.race_no}` : "";
    const items = parseGearItems(row.gear_raw);
    const hash = await contentHash({
      horse_code,
      race_date: args.meeting_date,
      race_index,
      gear: row.gear_raw,
      source: "starter_pdf",
    });
    const result = await db
      .prepare(
        `INSERT INTO gear_changes (
           horse_code, race_date, race_index, venue, race_no, track, course,
           gear_raw, gear_items_json, data_source, source_url, content_hash, scraped_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'starter_pdf', ?, ?, ?)
         ON CONFLICT(horse_code, race_date, race_index) DO UPDATE SET
           venue=excluded.venue,
           race_no=COALESCE(excluded.race_no, gear_changes.race_no),
           gear_raw=excluded.gear_raw,
           gear_items_json=excluded.gear_items_json,
           data_source=excluded.data_source,
           source_url=excluded.source_url,
           content_hash=excluded.content_hash,
           scraped_at=excluded.scraped_at`,
      )
      .bind(
        horse_code,
        args.meeting_date,
        race_index || String(row.horse_no ?? ""),
        args.venue,
        row.race_no,
        row.gear_raw,
        JSON.stringify(items),
        args.source_url,
        hash,
        now,
      )
      .run();
    if (args.env) await trackD1Result(args.env, result);
    n++;
  }
  return n;
}

export async function upsertQuinellaPoolStats(
  db: D1Database,
  args: {
    meeting_date: string;
    venue: string;
    pools: Array<{
      race_no: number;
      pool_type: string;
      investment: number | null;
      status: string | null;
      sell_status: string | null;
      last_update_time: string | null;
    }>;
    env?: Env;
  },
): Promise<number> {
  const now = new Date().toISOString();
  let n = 0;
  for (const p of args.pools) {
    const hash = await contentHash(p);
    const result = await db
      .prepare(
        `INSERT INTO quinella_pool_stats (
           meeting_date, venue, race_no, pool_type, investment, status, sell_status,
           last_update_time, data_source, content_hash, scraped_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'graphql', ?, ?)
         ON CONFLICT(meeting_date, venue, race_no, pool_type) DO UPDATE SET
           investment=excluded.investment,
           status=excluded.status,
           sell_status=excluded.sell_status,
           last_update_time=excluded.last_update_time,
           content_hash=excluded.content_hash,
           scraped_at=excluded.scraped_at`,
      )
      .bind(
        args.meeting_date,
        args.venue,
        p.race_no,
        p.pool_type,
        p.investment,
        p.status,
        p.sell_status,
        p.last_update_time,
        hash,
        now,
      )
      .run();
    if (args.env) await trackD1Result(args.env, result);
    n++;
  }
  return n;
}

export async function listGearChanges(
  db: D1Database,
  args: { horse_code?: string; date?: string; venue?: string },
) {
  const clauses: string[] = [];
  const binds: Array<string | number> = [];
  if (args.horse_code) {
    clauses.push("horse_code=?");
    binds.push(args.horse_code);
  }
  if (args.date) {
    clauses.push("race_date=?");
    binds.push(args.date);
  }
  if (args.venue) {
    clauses.push("venue=?");
    binds.push(args.venue);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await db
    .prepare(
      `SELECT * FROM gear_changes ${where} ORDER BY race_date DESC, race_no, horse_code LIMIT 500`,
    )
    .bind(...binds)
    .all();
  return results ?? [];
}

export async function listOfficialRatings(
  db: D1Database,
  args: { horse_code?: string; date?: string },
) {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (args.horse_code) {
    clauses.push("horse_code=?");
    binds.push(args.horse_code);
  }
  if (args.date) {
    clauses.push("race_date=?");
    binds.push(args.date);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await db
    .prepare(
      `SELECT * FROM official_ratings ${where} ORDER BY race_date DESC, race_index DESC LIMIT 500`,
    )
    .bind(...binds)
    .all();
  return results ?? [];
}

export async function listDeclaredWeights(
  db: D1Database,
  args: { horse_code?: string; date?: string; venue?: string },
) {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (args.horse_code) {
    clauses.push("horse_code=?");
    binds.push(args.horse_code);
  }
  if (args.date) {
    clauses.push("race_date=?");
    binds.push(args.date);
  }
  if (args.venue) {
    clauses.push("venue=?");
    binds.push(args.venue);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await db
    .prepare(
      `SELECT * FROM declared_horse_weights ${where} ORDER BY race_date DESC LIMIT 500`,
    )
    .bind(...binds)
    .all();
  return results ?? [];
}

export async function listRailPositions(
  db: D1Database,
  args: { date?: string; venue?: string },
) {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (args.date) {
    clauses.push("meeting_date=?");
    binds.push(args.date);
  }
  if (args.venue) {
    clauses.push("venue=?");
    binds.push(args.venue);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await db
    .prepare(
      `SELECT * FROM rail_positions ${where} ORDER BY meeting_date DESC, venue, track LIMIT 500`,
    )
    .bind(...binds)
    .all();
  return results ?? [];
}

export async function listBarrierTrials(
  db: D1Database,
  args: { date?: string; horse_code?: string; batch_no?: number | null },
) {
  const clauses: string[] = [];
  const binds: Array<string | number> = [];
  if (args.date) {
    clauses.push("trial_date=?");
    binds.push(args.date);
  }
  if (args.horse_code) {
    clauses.push("horse_code=?");
    binds.push(args.horse_code);
  }
  if (args.batch_no != null) {
    clauses.push("batch_no=?");
    binds.push(args.batch_no);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await db
    .prepare(
      `SELECT * FROM barrier_trials ${where}
       ORDER BY trial_date DESC, batch_no, finish_time LIMIT 500`,
    )
    .bind(...binds)
    .all();
  return results ?? [];
}

export async function listQuinellaPools(
  db: D1Database,
  args: { date: string; venue: string; race_no?: number | null },
) {
  if (args.race_no != null) {
    const { results } = await db
      .prepare(
        `SELECT * FROM quinella_pool_stats
         WHERE meeting_date=? AND venue=? AND race_no=?
         ORDER BY pool_type`,
      )
      .bind(args.date, args.venue, args.race_no)
      .all();
    return results ?? [];
  }
  const { results } = await db
    .prepare(
      `SELECT * FROM quinella_pool_stats
       WHERE meeting_date=? AND venue=?
       ORDER BY race_no, pool_type`,
    )
    .bind(args.date, args.venue)
    .all();
  return results ?? [];
}
