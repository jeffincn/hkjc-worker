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
import { buildEnvelope } from "../push/envelope";
import { sendPush } from "../push/pusher";
import {
  replaceHorseRuns,
  storeRawDocument,
  upsertHorseProfile,
  upsertInjuries,
} from "../store/horses";

const POLITE_MS = 500;

export interface HorseRefreshResult {
  profiles_changed: string[];
  runs_changed: string[];
  injuries_changed: boolean;
  fetched: number;
  skipped: number;
}

/**
 * Refresh horse profile + past runs for codes entered in a meeting.
 * Once when racecard first seen; again on race day (not every 10s).
 */
export async function refreshMeetingHorses(
  env: Env,
  args: {
    meeting_date: string;
    venue: string;
    horse_codes: string[];
    is_race_day: boolean;
    fetchImpl?: typeof fetch;
  },
): Promise<HorseRefreshResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const batchLimit = envNum(env, "HORSE_REFRESH_BATCH" as keyof Env, 15);
  const profiles_changed: string[] = [];
  const runs_changed: string[] = [];
  let fetched = 0;
  let skipped = 0;

  for (const code of args.horse_codes) {
    if (!code) continue;
    if (fetched >= batchLimit) {
      skipped++;
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

    await storeRawDocument(env.DB, "html_horse_page", code, { length: html.length, url }, url);

    const profile = parseHorseProfile(html, code, url);
    const profileResult = await upsertHorseProfile(env.DB, profile, {
      profile,
      // store structured only; full HTML is large — hash of profile+runs is enough for change detect
    });
    if (profileResult.changed) profiles_changed.push(code);

    const runs = parsePastRuns(html);
    const runsResult = await replaceHorseRuns(env.DB, code, runs, url);
    if (runsResult.changed) runs_changed.push(code);

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
        runsResult.content_hash,
        state?.first_seen_at ?? new Date().toISOString(),
        new Date().toISOString(),
        args.is_race_day ? 1 : 0,
        args.is_race_day ? 1 : 0,
      )
      .run();
  }

  // Meeting-level veterinary records (official page — GraphQL has no injury fields)
  await sleep(POLITE_MS);
  const vetUrl = VET_PAGE_URL(args.meeting_date, args.venue);
  let injuries_changed = false;
  try {
    const vetRes = await fetchImpl(vetUrl, {
      headers: { "User-Agent": "hkjc-data-worker/1.0", Accept: "text/html" },
    });
    if (vetRes.ok) {
      const vetHtml = await vetRes.text();
      const vetRecords = parseVetRecords(vetHtml).map((r) => ({
        ...r,
        horse_code: matchHorseCode(r.horse_name, args.horse_codes, null),
        meeting_date: args.meeting_date,
        venue: args.venue,
      }));
      // Prefer matching by name from DB
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
      injuries_changed = inj.changed;
    }
  } catch {
    // optional
  }

  // Batched pushes per meeting — never per-horse spam
  if (profiles_changed.length > 0) {
    await sendPush(
      env,
      buildEnvelope({
        event: "horse_update",
        meeting_date: args.meeting_date,
        venue: args.venue,
        meta: {
          horse_codes: profiles_changed,
          count: profiles_changed.length,
          content_hash: await hashPayload(profiles_changed),
        },
      }),
    );
  }
  if (runs_changed.length > 0) {
    await sendPush(
      env,
      buildEnvelope({
        event: "runs_update",
        meeting_date: args.meeting_date,
        venue: args.venue,
        meta: {
          horse_codes: runs_changed,
          count: runs_changed.length,
          content_hash: await hashPayload(runs_changed),
        },
      }),
    );
  }
  if (injuries_changed) {
    await sendPush(
      env,
      buildEnvelope({
        event: "injury_update",
        meeting_date: args.meeting_date,
        venue: args.venue,
        meta: { source: vetUrl },
      }),
    );
  }

  return { profiles_changed, runs_changed, injuries_changed, fetched, skipped };
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
