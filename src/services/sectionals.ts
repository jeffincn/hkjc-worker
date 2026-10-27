import type { Env } from "../env";
import {
  hashSectionalRace,
  parseSectionalPage,
  SECTIONAL_PAGE_URL,
} from "../html/sectional";
import { emitPush } from "../push/emit";
import { formatHkNow } from "../push/envelope";
import {
  isSectionalRaceSettled,
  lookupSectionalDayVenue,
  markSectionalProgress,
  pageToStoreArgs,
  replaceRaceSectionals,
} from "../store/sectionals";
import type { SubrequestBudget } from "../util/budget";

/** Jeff / issue #46: ≥3s between HKJC sectional page requests. */
export const SECTIONAL_MIN_DELAY_MS = 3000;

/**
 * Date-iteration backfill default (issue #49).
 * Probe 2014-09-14: archive displaysectionaltime matches 2015+ table layout
 * (race_table + per-horse sections; splits=null). Include from season open.
 */
export const SECTIONAL_DATE_MODE_DEFAULT_FROM = "2014-09-14";

/** Sentinel venue in sectional_ingest_progress for calendar days with no meeting. */
export const SECTIONAL_DATE_MODE_EMPTY_VENUE = "--";

/** HKJC local cards are ≤11; probe one past that to confirm end-of-meeting. */
export const SECTIONAL_DATE_MODE_MAX_RACE_NO = 12;

export type SectionalBackfillMode = "races" | "date";

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
  mode: SectionalBackfillMode;
  processed: SectionalRaceResult[];
  remaining_estimate: number;
  limit_races: number;
  delay_ms: number;
  /** Date-mode only: last calendar date touched in this step. */
  cursor_date?: string | null;
  from?: string;
  to?: string;
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
    (await isSectionalRaceSettled(env.DB, args.meeting_date, args.venue, args.race_no))
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
 * Resumable backfill. Default mode `races` aligns with existing D1 `races` rows
 * (unchanged for existing callers). Pass `mode: "date"` for calendar iteration
 * that does not require `races` rows (issue #49).
 */
export async function runSectionalBackfillStep(
  env: Env,
  opts?: {
    mode?: SectionalBackfillMode | string;
    date?: string;
    venue?: string;
    from?: string;
    to?: string;
    limit_races?: number;
    delay_ms?: number;
    force?: boolean;
    fetchImpl?: typeof fetch;
    /** Test-only: allow delay_ms below SECTIONAL_MIN_DELAY_MS. */
    allow_below_min_delay?: boolean;
  },
): Promise<SectionalBackfillResult> {
  const mode = normalizeBackfillMode(opts?.mode);
  if (mode === "date") {
    return runSectionalDateBackfillStep(env, opts);
  }
  return runSectionalRacesBackfillStep(env, opts);
}

function resolveSectionalDelayMs(opts?: {
  delay_ms?: number;
  allow_below_min_delay?: boolean;
}): number {
  const raw = opts?.delay_ms ?? SECTIONAL_MIN_DELAY_MS;
  if (opts?.allow_below_min_delay) return Math.max(0, raw);
  return Math.max(SECTIONAL_MIN_DELAY_MS, raw);
}

function normalizeBackfillMode(raw: string | undefined): SectionalBackfillMode {
  if (raw === "date" || raw === "calendar" || raw === "by_date") return "date";
  return "races";
}

/**
 * Resumable backfill aligned with existing `races` rows (meetings already in D1).
 * Default `from`: 2015-09-01 (2015/16 season) when omitted.
 */
export async function runSectionalRacesBackfillStep(
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
    allow_below_min_delay?: boolean;
  },
): Promise<SectionalBackfillResult> {
  const limit = Math.max(1, Math.min(opts?.limit_races ?? 20, 100));
  const delay_ms = resolveSectionalDelayMs(opts);
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
    mode: "races",
    processed,
    remaining_estimate: Math.max(0, pending.length - batch.length),
    limit_races: limit,
    delay_ms,
    from,
    to,
  };
}

/**
 * Calendar date-iteration backfill (issue #49): walk `from`→`to` day-by-day /
 * race-by-race without requiring D1 `races` rows. Checkpoint via
 * `sectional_ingest_progress` (done/empty). Prefer night batches; ≥3s/request.
 * Does not emit live `sectionals` push (bulk history).
 */
export async function runSectionalDateBackfillStep(
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
    max_race_no?: number;
    allow_below_min_delay?: boolean;
  },
): Promise<SectionalBackfillResult> {
  const limit = Math.max(1, Math.min(opts?.limit_races ?? 20, 100));
  const delay_ms = resolveSectionalDelayMs(opts);
  const force = opts?.force === true;
  const from = opts?.date ?? opts?.from ?? SECTIONAL_DATE_MODE_DEFAULT_FROM;
  const to = opts?.date ?? opts?.to ?? hkTodayYmd();
  const maxRace = Math.max(
    1,
    Math.min(opts?.max_race_no ?? SECTIONAL_DATE_MODE_MAX_RACE_NO, 14),
  );
  const venueFilter = opts?.venue?.toUpperCase();
  const emptyVenue = SECTIONAL_DATE_MODE_EMPTY_VENUE;

  const processed: SectionalRaceResult[] = [];
  let fetchCount = 0;
  let firstFetch = true;
  let cursor_date: string | null = null;
  let date = from;

  while (date <= to && fetchCount < limit) {
    cursor_date = date;

    if (
      !force &&
      (await isSectionalRaceSettled(env.DB, date, emptyVenue, 1)) &&
      !(await lookupSectionalDayVenue(env.DB, date, emptyVenue))
    ) {
      date = addCalendarDays(date, 1);
      continue;
    }

    let dayVenue = await lookupSectionalDayVenue(env.DB, date, emptyVenue);

    if (dayVenue && venueFilter && dayVenue !== venueFilter) {
      date = addCalendarDays(date, 1);
      continue;
    }

    let endOfMeeting = false;
    for (let race_no = 1; race_no <= maxRace && fetchCount < limit; race_no++) {
      if (dayVenue) {
        if (!force && (await isSectionalRaceSettled(env.DB, date, dayVenue, race_no))) {
          const st = await progressStatus(env.DB, date, dayVenue, race_no);
          if (st === "empty") {
            endOfMeeting = true;
            break;
          }
          continue;
        }
        if (!firstFetch) await sleep(delay_ms);
        firstFetch = false;
        fetchCount++;
        const r = await ingestSectionalRace(env, {
          meeting_date: date,
          venue: dayVenue,
          race_no,
          force,
          delay_ms,
          fetchImpl: opts?.fetchImpl,
          skip_delay: true,
        });
        processed.push(r);
        if (r.status === "empty") {
          endOfMeeting = true;
          break;
        }
        continue;
      }

      // Venue unknown — probe this race_no (normally 1).
      if (!firstFetch) await sleep(delay_ms);
      firstFetch = false;
      fetchCount++;
      const probed = await ingestSectionalRaceDateProbe(env, {
        meeting_date: date,
        race_no,
        force,
        delay_ms,
        fetchImpl: opts?.fetchImpl,
        skip_delay: true,
      });
      processed.push(probed.result);

      if (!probed.day_venue) {
        // NO RACE / empty calendar day (or error). Advance date.
        endOfMeeting = true;
        break;
      }

      dayVenue = probed.day_venue;
      if (venueFilter && dayVenue !== venueFilter) {
        // Stored under real venue; this filtered run skips the rest of the day.
        endOfMeeting = true;
        break;
      }
      // Continue race_no+1 with known venue in the same step.
    }

    if (fetchCount >= limit) break;
    if (endOfMeeting || (await isDateMeetingFullySettled(env.DB, date, dayVenue, maxRace))) {
      date = addCalendarDays(date, 1);
    } else if (dayVenue) {
      // Mid-card (hit limit or unexpected); next invocation resumes same date.
      break;
    } else {
      date = addCalendarDays(date, 1);
    }
  }

  const remaining_estimate = await estimateRemainingDateSlots(env.DB, {
    from: date,
    to,
    force,
    max_race_no: maxRace,
    venue: venueFilter,
  });

  return {
    mode: "date",
    processed,
    remaining_estimate,
    limit_races: limit,
    delay_ms,
    cursor_date,
    from,
    to,
  };
}

/**
 * Probe one (date, race_no) when venue is not yet known for that calendar day.
 * Empty / NO RACE → mark progress under sentinel venue `--` and continue.
 * Horses found → store under page venue (ST/HV) via normal sectional_times path.
 */
async function ingestSectionalRaceDateProbe(
  env: Env,
  args: {
    meeting_date: string;
    race_no: number;
    force?: boolean;
    delay_ms?: number;
    fetchImpl?: typeof fetch;
    skip_delay?: boolean;
  },
): Promise<{ result: SectionalRaceResult; day_venue: string | null }> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const emptyVenue = SECTIONAL_DATE_MODE_EMPTY_VENUE;
  const base: Pick<SectionalRaceResult, "meeting_date" | "venue" | "race_no"> = {
    meeting_date: args.meeting_date,
    venue: emptyVenue,
    race_no: args.race_no,
  };

  if (
    !args.force &&
    (await isSectionalRaceSettled(env.DB, args.meeting_date, emptyVenue, args.race_no))
  ) {
    return {
      result: { ...base, status: "skipped" },
      day_venue: null,
    };
  }

  const delay = Math.max(SECTIONAL_MIN_DELAY_MS, args.delay_ms ?? SECTIONAL_MIN_DELAY_MS);
  if (!args.skip_delay) await sleep(delay);

  const source_url = SECTIONAL_PAGE_URL(args.meeting_date, args.race_no);
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
        venue: emptyVenue,
        race_no: args.race_no,
        status: "error",
        source_url,
        scraped_at: new Date().toISOString(),
        error_message: msg,
        env,
      });
      return {
        result: { ...base, status: "error", error: msg, source_url },
        day_venue: null,
      };
    }

    const html = await res.text();
    const finalUrl = res.url || source_url;
    const page = parseSectionalPage(html, {
      source_url: finalUrl,
      meeting_date: args.meeting_date,
      race_no: args.race_no,
    });

    if (page.horses.length === 0) {
      await markSectionalProgress(env.DB, {
        meeting_date: args.meeting_date,
        venue: emptyVenue,
        race_no: args.race_no,
        status: "empty",
        source_url: finalUrl,
        scraped_at: new Date().toISOString(),
        error_message: "no horses parsed / NO RACE",
        env,
      });
      return {
        result: { ...base, status: "empty", source_url: finalUrl },
        day_venue: null,
      };
    }

    const venue = (page.venue ?? "ST").toUpperCase();
    const store = pageToStoreArgs(page, {
      meeting_date: args.meeting_date,
      venue,
      race_no: args.race_no,
    });
    store.meeting_date = args.meeting_date;
    store.venue = venue;
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
      result: {
        meeting_date: args.meeting_date,
        venue,
        race_no: args.race_no,
        status: upsert.changed ? (upsert.rows > 0 ? "done" : "empty") : "unchanged",
        rows: upsert.rows,
        content_hash: upsert.content_hash,
        source_url: finalUrl,
      },
      day_venue: venue,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markSectionalProgress(env.DB, {
      meeting_date: args.meeting_date,
      venue: emptyVenue,
      race_no: args.race_no,
      status: "error",
      source_url,
      scraped_at: new Date().toISOString(),
      error_message: msg,
      env,
    });
    return {
      result: { ...base, status: "error", error: msg, source_url },
      day_venue: null,
    };
  }
}

export interface SectionalDateSlot {
  meeting_date: string;
  /** null = venue unknown; caller must probe. */
  venue: string | null;
  race_no: number;
}

async function progressStatus(
  db: D1Database,
  meeting_date: string,
  venue: string,
  race_no: number,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT status FROM sectional_ingest_progress
       WHERE meeting_date=? AND venue=? AND race_no=?`,
    )
    .bind(meeting_date, venue, race_no)
    .first<{ status: string }>();
  return row?.status ?? null;
}

async function isDateMeetingFullySettled(
  db: D1Database,
  meeting_date: string,
  venue: string | null,
  maxRace: number,
): Promise<boolean> {
  if (!venue) {
    return isSectionalRaceSettled(db, meeting_date, SECTIONAL_DATE_MODE_EMPTY_VENUE, 1);
  }
  for (let race_no = 1; race_no <= maxRace; race_no++) {
    const st = await progressStatus(db, meeting_date, venue, race_no);
    if (st === "empty") return true;
    if (st !== "done") return false;
  }
  return true;
}

/**
 * Soft remaining estimate for date-mode (calendar days left × typical card),
 * minus days already marked empty / fully settled. Not exact race count.
 */
async function estimateRemainingDateSlots(
  db: D1Database,
  opts: {
    from: string;
    to: string;
    force?: boolean;
    max_race_no: number;
    venue?: string;
  },
): Promise<number> {
  if (opts.from > opts.to) return 0;
  let n = 0;
  let date = opts.from;
  let guard = 0;
  while (date <= opts.to && guard < 4000) {
    guard++;
    const dayVenue = await lookupSectionalDayVenue(db, date, SECTIONAL_DATE_MODE_EMPTY_VENUE);
    if (
      !opts.force &&
      !dayVenue &&
      (await isSectionalRaceSettled(db, date, SECTIONAL_DATE_MODE_EMPTY_VENUE, 1))
    ) {
      date = addCalendarDays(date, 1);
      continue;
    }
    if (dayVenue && opts.venue && dayVenue !== opts.venue) {
      date = addCalendarDays(date, 1);
      continue;
    }
    if (dayVenue && (await isDateMeetingFullySettled(db, date, dayVenue, opts.max_race_no))) {
      date = addCalendarDays(date, 1);
      continue;
    }
    // Rough: count unsettled races if venue known, else 1 probe.
    if (dayVenue) {
      for (let r = 1; r <= opts.max_race_no; r++) {
        if (opts.force || !(await isSectionalRaceSettled(db, date, dayVenue, r))) n++;
        else if ((await progressStatus(db, date, dayVenue, r)) === "empty") break;
      }
    } else {
      n += 1;
    }
    date = addCalendarDays(date, 1);
    if (n > 500) return n; // cap walk cost
  }
  return n;
}

/**
 * Build the next unsettled (date, race) slots for date-mode backfill (tests /
 * dry planning). Walks calendar days; skips done/empty; does not skip gaps.
 */
export async function listPendingSectionalDateSlots(opts: {
  db: D1Database;
  from: string;
  to: string;
  limit: number;
  force?: boolean;
  max_race_no?: number;
  venue?: string;
}): Promise<SectionalDateSlot[]> {
  const maxRace = opts.max_race_no ?? SECTIONAL_DATE_MODE_MAX_RACE_NO;
  const emptyVenue = SECTIONAL_DATE_MODE_EMPTY_VENUE;
  const out: SectionalDateSlot[] = [];
  let date = opts.from;

  while (date <= opts.to && out.length < opts.limit) {
    const dayVenue = await lookupSectionalDayVenue(opts.db, date, emptyVenue);

    if (
      !opts.force &&
      !dayVenue &&
      (await isSectionalRaceSettled(opts.db, date, emptyVenue, 1))
    ) {
      date = addCalendarDays(date, 1);
      continue;
    }

    if (dayVenue) {
      if (opts.venue && dayVenue !== opts.venue.toUpperCase()) {
        date = addCalendarDays(date, 1);
        continue;
      }
      for (let race_no = 1; race_no <= maxRace; race_no++) {
        if (!opts.force && (await isSectionalRaceSettled(opts.db, date, dayVenue, race_no))) {
          if ((await progressStatus(opts.db, date, dayVenue, race_no)) === "empty") break;
          continue;
        }
        out.push({ meeting_date: date, venue: dayVenue, race_no });
        if (out.length >= opts.limit) return out;
      }
      date = addCalendarDays(date, 1);
      continue;
    }

    out.push({ meeting_date: date, venue: null, race_no: 1 });
    if (out.length >= opts.limit) return out;
    date = addCalendarDays(date, 1);
  }

  return out;
}

/** YYYY-MM-DD + N calendar days (UTC date arithmetic; HKJC dates are civil). */
export function addCalendarDays(ymd: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return ymd;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function hkTodayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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
