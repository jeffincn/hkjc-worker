import type { Env } from "../env";
import { envNum } from "../env";
import {
  HORSE_PAGE_URL,
  VET_PAGE_URL,
  hashPayload,
  parseHorseProfile,
  parsePastRuns,
  parseVetRecords,
} from "../html/horse";
import { emitPush } from "../push/emit";
import {
  replaceHorseRuns,
  storeRawDocument,
  upsertHorseProfile,
  upsertInjuries,
} from "../store/horses";
import type { SubrequestBudget } from "../util/budget";
import { runStage } from "../util/stage";

const POLITE_MS = 500;

export interface HorseRefreshResult {
  profiles_changed: string[];
  runs_changed: string[];
  injuries_changed: boolean;
  fetched: number;
  skipped: number;
  deferred: number;
}

/**
 * Refresh horse profile + past runs for codes entered in a meeting.
 * Once when racecard first seen; again on race day (not every 30s).
 * Heavy fetches respect SubrequestBudget — remaining work resumes next run.
 */
export async function refreshMeetingHorses(
  env: Env,
  args: {
    meeting_date: string;
    venue: string;
    horse_codes: string[];
    is_race_day: boolean;
    fetchImpl?: typeof fetch;
    budget?: SubrequestBudget;
  },
): Promise<HorseRefreshResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const batchLimit = envNum(env, "HORSE_REFRESH_BATCH" as keyof Env, 15);
  const profiles_changed: string[] = [];
  const runs_changed: string[] = [];
  let fetched = 0;
  let skipped = 0;
  let deferred = 0;

  for (const code of args.horse_codes) {
    if (!code) continue;
    if (fetched >= batchLimit) {
      skipped++;
      continue;
    }
    if (args.budget && !args.budget.canAfford(1)) {
      deferred++;
      continue;
    }
    const state = await env.DB.prepare(
      `SELECT first_seen_at, race_day_refreshed, last_fetched_at FROM horse_fetch_state WHERE horse_code=?`,
    )
      .bind(code)
      .first<{ first_seen_at: string; race_day_refreshed: number; last_fetched_at: string }>();

    const firstSeen = !state?.first_seen_at;
    const needRaceDay = args.is_race_day && !state?.race_day_refreshed;
    if (!firstSeen && !needRaceDay) {
      skipped++;
      continue;
    }

    await sleep(POLITE_MS);
    args.budget?.charge(1);
    const url = HORSE_PAGE_URL(code, "1");
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": "hkjc-data-worker/1.0",
        Accept: "text/html",
      },
    });
    if (!res.ok) continue;
    const html = await res.text();
    fetched++;

    await storeRawDocument(env.DB, "html_horse_page", code, { length: html.length, url }, url, {
      env,
    });

    const profile = parseHorseProfile(html, code, url);
    const profileResult = await upsertHorseProfile(env.DB, profile, {
      profile,
      // store structured only; full HTML is large — hash of profile+runs is enough for change detect
    });
    if (profileResult.changed) profiles_changed.push(code);

    const runsResult = await runStage(env, "runs", async () => {
      const runs = parsePastRuns(html);
      return replaceHorseRuns(env.DB, code, runs, url);
    });
    const runsHash =
      runsResult.ok && runsResult.value.changed
        ? (runs_changed.push(code), runsResult.value.content_hash)
        : runsResult.ok
          ? runsResult.value.content_hash
          : null;

    await env.DB.prepare(
      `INSERT INTO horse_fetch_state (horse_code, meeting_date, venue, last_profile_hash, last_runs_hash, first_seen_at, last_fetched_at, race_day_refreshed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(horse_code) DO UPDATE SET
         meeting_date=excluded.meeting_date,
         venue=excluded.venue,
         last_profile_hash=excluded.last_profile_hash,
         last_runs_hash=COALESCE(excluded.last_runs_hash, horse_fetch_state.last_runs_hash),
         last_fetched_at=excluded.last_fetched_at,
         race_day_refreshed=CASE WHEN ? THEN 1 ELSE horse_fetch_state.race_day_refreshed END`,
    )
      .bind(
        code,
        args.meeting_date,
        args.venue,
        profileResult.content_hash,
        runsHash,
        state?.first_seen_at ?? new Date().toISOString(),
        new Date().toISOString(),
        args.is_race_day ? 1 : 0,
        args.is_race_day ? 1 : 0,
      )
      .run();
  }

  // Meeting-level veterinary records (official page — GraphQL has no injury fields)
  const vetUrl = VET_PAGE_URL(args.meeting_date, args.venue);
  let injuries_changed = false;
  const injResult = await runStage(env, "injuries", async () => {
    if (args.budget && !args.budget.canAfford(1)) {
      deferred++;
      return false;
    }
    await sleep(POLITE_MS);
    args.budget?.charge(1);
    const vetRes = await fetchImpl(vetUrl, {
      headers: { "User-Agent": "hkjc-data-worker/1.0", Accept: "text/html" },
    });
    if (!vetRes.ok) return false;
    const vetHtml = await vetRes.text();
    const vetRecords = parseVetRecords(vetHtml).map((r) => ({
      ...r,
      horse_code: matchHorseCode(r.horse_name, args.horse_codes, null),
      meeting_date: args.meeting_date,
      venue: args.venue,
    }));
    for (const rec of vetRecords) {
      if (!rec.horse_code && rec.horse_name) {
        const row = await env.DB.prepare(
          `SELECT horse_code FROM horses WHERE upper(name_en)=upper(?) LIMIT 1`,
        )
          .bind(rec.horse_name)
          .first<{ horse_code: string }>();
        rec.horse_code = row?.horse_code ?? null;
      }
    }
    const inj = await upsertInjuries(env.DB, vetRecords, vetUrl);
    return inj.changed;
  });
  if (injResult.ok) injuries_changed = injResult.value;

  // Batched pushes per meeting — never per-horse spam
  await runStage(env, "pushes", async () => {
    if (profiles_changed.length > 0) {
      await emitPush(env, {
        event: "horse_update",
        meeting_date: args.meeting_date,
        venue: args.venue,
        meta: {
          horse_codes: profiles_changed,
          count: profiles_changed.length,
          content_hash: await hashPayload(profiles_changed),
        },
      });
    }
    if (runs_changed.length > 0) {
      await emitPush(env, {
        event: "runs_update",
        meeting_date: args.meeting_date,
        venue: args.venue,
        meta: {
          horse_codes: runs_changed,
          count: runs_changed.length,
          content_hash: await hashPayload(runs_changed),
        },
      });
    }
    if (injuries_changed) {
      await emitPush(env, {
        event: "injury_update",
        meeting_date: args.meeting_date,
        venue: args.venue,
        meta: { source: vetUrl },
      });
    }
  });

  return { profiles_changed, runs_changed, injuries_changed, fetched, skipped, deferred };
}

function matchHorseCode(
  name: string | null,
  codes: string[],
  _map: Map<string, string> | null,
): string | null {
  void name;
  void codes;
  void _map;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
