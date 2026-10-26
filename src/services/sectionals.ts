import type { Env } from "../env";
import {
  hashSectionalRace,
  parseSectionalPage,
  SECTIONAL_PAGE_URL,
} from "../html/sectional";
import { emitPush } from "../push/emit";
import { formatHkNow } from "../push/envelope";
import {
  isSectionalRaceDone,
  markSectionalProgress,
  pageToStoreArgs,
  replaceRaceSectionals,
} from "../store/sectionals";
import type { SubrequestBudget } from "../util/budget";

/** Jeff / issue #46: ≥3s between HKJC sectional page requests. */
export const SECTIONAL_MIN_DELAY_MS = 3000;

export interface SectionalRaceResult {
  meeting_date: string;
  venue: string;
  race_no: number;
  status: "done" | "unchanged" | "empty" | "error" | "skipped" | "deferred";
  rows?: number;
  content_hash?: string;
  error?: string;
  source_url?: string;
}

export interface SectionalMeetingResult {
  meeting_date: string;
  venue: string;
  processed: SectionalRaceResult[];
  changed_races: number[];
  pushed: boolean;
}

export interface SectionalBackfillResult {
  processed: SectionalRaceResult[];
  remaining_estimate: number;
  limit_races: number;
  delay_ms: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch + parse + upsert one race page. Caller owns rate limiting between races.
 */
export async function ingestSectionalRace(
  env: Env,
  args: {
    meeting_date: string;
    venue: string;
    race_no: number;
    force?: boolean;
    delay_ms?: number;
    fetchImpl?: typeof fetch;
    budget?: SubrequestBudget;
    skip_delay?: boolean;
  },
): Promise<SectionalRaceResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const base: Pick<SectionalRaceResult, "meeting_date" | "venue" | "race_no"> = {
    meeting_date: args.meeting_date,
    venue: args.venue,
    race_no: args.race_no,
  };

  if (
    !args.force &&
    (await isSectionalRaceDone(env.DB, args.meeting_date, args.venue, args.race_no))
  ) {
    return { ...base, status: "skipped" };
  }

  if (args.budget && !args.budget.canAfford(1)) {
    return { ...base, status: "deferred" };
  }

  const delay = Math.max(SECTIONAL_MIN_DELAY_MS, args.delay_ms ?? SECTIONAL_MIN_DELAY_MS);
  if (!args.skip_delay) await sleep(delay);

  const source_url = SECTIONAL_PAGE_URL(args.meeting_date, args.race_no);
  args.budget?.charge(1);

  try {
    const res = await fetchImpl(source_url, {
      headers: {
        "User-Agent": "hkjc-data-worker/1.0",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      const msg = `HTTP ${res.status}`;
      await markSectionalProgress(env.DB, {
        meeting_date: args.meeting_date,
        venue: args.venue,
        race_no: args.race_no,
        status: "error",
        source_url,
        scraped_at: new Date().toISOString(),
        error_message: msg,
        env,
      });
      return { ...base, status: "error", error: msg, source_url };
    }

    const html = await res.text();
    const finalUrl = res.url || source_url;
    const page = parseSectionalPage(html, {
      source_url: finalUrl,
      venue: args.venue,
      meeting_date: args.meeting_date,
      race_no: args.race_no,
    });

    if (page.horses.length === 0) {
      await markSectionalProgress(env.DB, {
        meeting_date: args.meeting_date,
        venue: args.venue,
        race_no: args.race_no,
        status: "empty",
        source_url: finalUrl,
        scraped_at: new Date().toISOString(),
        error_message: "no horses parsed",
        env,
      });
      return { ...base, status: "empty", source_url: finalUrl };
    }

    const store = pageToStoreArgs(page, {
      meeting_date: args.meeting_date,
      venue: args.venue,
      race_no: args.race_no,
    });
    // Prefer caller venue/date/race (meetings table) over page inference.
    store.meeting_date = args.meeting_date;
    store.venue = args.venue;
    store.race_no = args.race_no;

    const content_hash = await hashSectionalRace(
      store.meeting_date,
      store.venue,
      store.race_no,
      store.horses,
      store.race_info,
    );

    const upsert = await replaceRaceSectionals(env.DB, {
      ...store,
      content_hash,
      env,
    });

    return {
      ...base,
      status: upsert.changed ? (upsert.rows > 0 ? "done" : "empty") : "unchanged",
      rows: upsert.rows,
      content_hash: upsert.content_hash,
      source_url: finalUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markSectionalProgress(env.DB, {
      meeting_date: args.meeting_date,
      venue: args.venue,
      race_no: args.race_no,
      status: "error",
      source_url,
      scraped_at: new Date().toISOString(),
      error_message: msg,
      env,
    });
    return { ...base, status: "error", error: msg, source_url };
  }
}

/**
 * Post-race: scrape sectionals for completed races of a meeting (budget-aware).
 * Emits one `sectionals` push per meeting when any race content_hash changed.
 */
export async function ingestMeetingSectionals(
  env: Env,
  args: {
    meeting_date: string;
    venue: string;
    race_nos: number[];
    force?: boolean;
    delay_ms?: number;
    fetchImpl?: typeof fetch;
    budget?: SubrequestBudget;
    /** When true (default), first race of this call skips the polite delay. */
    skip_first_delay?: boolean;
  },
): Promise<SectionalMeetingResult> {
  const processed: SectionalRaceResult[] = [];
  const changed_races: number[] = [];
  let first = true;
  const skipFirst = args.skip_first_delay !== false;

  for (const race_no of args.race_nos) {
    const r = await ingestSectionalRace(env, {
      meeting_date: args.meeting_date,
      venue: args.venue,
      race_no,
      force: args.force,
      delay_ms: args.delay_ms,
      fetchImpl: args.fetchImpl,
      budget: args.budget,
      skip_delay: first && skipFirst,
    });
    first = false;
    processed.push(r);
    if (r.status === "done") changed_races.push(race_no);
    if (r.status === "deferred") break;
  }

  let pushed = false;
  if (changed_races.length > 0) {
    const hashes = processed
      .filter((p) => p.content_hash && changed_races.includes(p.race_no))
      .map((p) => ({ race_no: p.race_no, content_hash: p.content_hash }));
    await emitPush(env, {
      event: "sectionals",
      meeting_date: args.meeting_date,
      venue: args.venue,
      captured_at: formatHkNow(),
      source_last_updated_at: null,
      meta: {
        race_nos: changed_races,
        races: hashes,
        content_hash: hashes.map((h) => h.content_hash).join("|"),
      },
    });
    pushed = true;
  }

  return {
    meeting_date: args.meeting_date,
    venue: args.venue,
    processed,
    changed_races,
    pushed,
  };
}

/**
 * Resumable backfill aligned with existing `races` rows (meetings already in D1).
 * Default `from`: 2015-09-01 (2015/16 season) when omitted.
 */
export async function runSectionalBackfillStep(
  env: Env,
  opts?: {
    date?: string;
    venue?: string;
    from?: string;
    to?: string;
    limit_races?: number;
    delay_ms?: number;
    force?: boolean;
    fetchImpl?: typeof fetch;
  },
): Promise<SectionalBackfillResult> {
  const limit = Math.max(1, Math.min(opts?.limit_races ?? 20, 100));
  const delay_ms = Math.max(SECTIONAL_MIN_DELAY_MS, opts?.delay_ms ?? SECTIONAL_MIN_DELAY_MS);
  const force = opts?.force === true;
  const from = opts?.from ?? "2015-09-01";
  const to = opts?.to ?? "2099-12-31";

  const pending = await listPendingSectionalRaces(env.DB, {
    date: opts?.date,
    venue: opts?.venue,
    from,
    to,
    limit: limit + 1,
    force,
  });
  const batch = pending.slice(0, limit);

  const processed: SectionalRaceResult[] = [];
  let i = 0;
  let meetingsSeen = 0;
  while (i < batch.length) {
    const { meeting_date, venue } = batch[i];
    const race_nos: number[] = [];
    while (
      i < batch.length &&
      batch[i].meeting_date === meeting_date &&
      batch[i].venue === venue
    ) {
      race_nos.push(batch[i].race_no);
      i++;
    }
    const result = await ingestMeetingSectionals(env, {
      meeting_date,
      venue,
      race_nos,
      force,
      delay_ms,
      fetchImpl: opts?.fetchImpl,
      // First race of the whole step may start immediately; later meetings wait ≥3s.
      skip_first_delay: meetingsSeen === 0,
    });
    meetingsSeen++;
    processed.push(...result.processed);
  }

  return {
    processed,
    remaining_estimate: Math.max(0, pending.length - batch.length),
    limit_races: limit,
    delay_ms,
  };
}

export async function listPendingSectionalRaces(
  db: D1Database,
  opts: {
    date?: string;
    venue?: string;
    from: string;
    to: string;
    limit: number;
    force?: boolean;
  },
): Promise<Array<{ meeting_date: string; venue: string; race_no: number }>> {
  const params: Array<string | number> = [];
  let sql = `
    SELECT r.meeting_date, r.venue, r.race_no
    FROM races r
    LEFT JOIN sectional_ingest_progress p
      ON p.meeting_date = r.meeting_date AND p.venue = r.venue AND p.race_no = r.race_no
    WHERE r.meeting_date >= ? AND r.meeting_date <= ?
      AND r.venue IN ('ST', 'HV')`;
  params.push(opts.from, opts.to);

  if (opts.date) {
    sql += ` AND r.meeting_date = ?`;
    params.push(opts.date);
  }
  if (opts.venue) {
    sql += ` AND r.venue = ?`;
    params.push(opts.venue);
  }
  if (!opts.force) {
    sql += ` AND (p.status IS NULL OR p.status NOT IN ('done', 'empty'))`;
  }
  sql += ` ORDER BY r.meeting_date ASC, r.venue ASC, r.race_no ASC LIMIT ?`;
  params.push(opts.limit);

  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ meeting_date: string; venue: string; race_no: number }>();
  return results ?? [];
}
