import type { Env } from "../env";
import { fetchGraphQL, WhitelistError } from "../graphql/client";
import {
  QUERY_PM_POOLS_ODDS,
  QUERY_RACE_MEETINGS_FULL,
  QUERY_RACING_CHANGES,
  QUERY_RESULT_MEETINGS,
} from "../graphql/queries";
import type {
  MeetingRaw,
  PmPoolsOddsData,
  RaceMeetingsFullData,
  RacingChangesData,
  ResultMeetingsData,
} from "../graphql/types";
import {
  isScratchedStatus,
  normalizeMeeting,
  pickHkActiveMeetings,
  resultsComplete,
} from "../parse/meeting";
import { buildRaceOddsSnapshot, poolsByRace } from "../parse/odds";
import { buildEnvelope, type PushRace } from "../push/envelope";
import { flushDueRetries, piggybackPending, sendPush } from "../push/pusher";
import {
  insertOddsSnapshotIfChanged,
  persistMeetingTree,
  setMeta,
  storeChangeHistories,
  storeDividendsAsResults,
} from "../store/db";
import { storeRawDocument } from "../store/horses";
import { refreshMeetingHorses } from "./horses";

export async function ingestActiveMeeting(env: Env): Promise<{
  meetings: Array<{ date: string; venue: string; races: number; snapshots_changed: number }>;
  whitelist_error?: string;
}> {
  await flushDueRetries(env);

  let data: RaceMeetingsFullData | null = null;
  try {
    // date/venue ignored for past meetings — always returns current/next
    const res = await fetchGraphQL<RaceMeetingsFullData>({
      query: QUERY_RACE_MEETINGS_FULL,
      variables: { date: "2026-10-07", venueCode: "HV" },
    });
    data = res.data ?? null;
  } catch (err) {
    if (err instanceof WhitelistError) {
      await setMeta(env.DB, "whitelist_error", err.message);
      await sendPush(
        env,
        buildEnvelope({
          event: "whitelist_alert",
          meta: { message: err.message },
        }),
        { force: true },
      );
      return { meetings: [], whitelist_error: err.message };
    }
    throw err;
  }

  await setMeta(env.DB, "whitelist_error", "");
  await setMeta(env.DB, "last_fetch_at", new Date().toISOString());

  if (data) {
    await storeRawDocument(env.DB, "graphql_raceMeetings_full", "active", data, null);
  }

  const active = pickHkActiveMeetings(data?.activeMeetings);
  const raceMeetings = (data?.raceMeetings ?? []).filter((m) =>
    ["ST", "HV"].includes(m.venueCode),
  );

  // Prefer detailed raceMeetings payload; fall back to active list dates
  const targets: MeetingRaw[] =
    raceMeetings.length > 0
      ? raceMeetings
      : active.map((a) => ({
          date: a.date,
          venueCode: a.venueCode,
          status: a.status,
          races: [],
        }));

  const out: Array<{ date: string; venue: string; races: number; snapshots_changed: number }> = [];

  for (const rawMeeting of targets) {
    const result = await ingestOneMeeting(env, rawMeeting, data);
    out.push(result);

    // Wake Durable Object for live polling on race days that are not fully closed
    if (rawMeeting.status !== "CLOSED" || hasOpenRaces(rawMeeting)) {
      const id = env.MEETING_DO.idFromName(`${rawMeeting.date}_${rawMeeting.venueCode}`);
      const stub = env.MEETING_DO.get(id);
      await stub.fetch("https://do/start", {
        method: "POST",
        body: JSON.stringify({
          meeting_date: rawMeeting.date,
          venue: rawMeeting.venueCode,
        }),
      });
    }
  }

  // Schedule push for daily schedule
  if (active.length > 0) {
    await sendPush(
      env,
      buildEnvelope({
        event: "schedule",
        meta: {
          active: active.map((a) => ({
            date: a.date,
            venue: a.venueCode,
            status: a.status,
            races: a.races?.map((r) => ({ no: r.no, postTime: r.postTime, status: r.status })),
          })),
        },
      }),
      { force: true },
    );
  }

  return { meetings: out };
}

function hasOpenRaces(m: MeetingRaw): boolean {
  return (m.races ?? []).some((r) => {
    const s = (r.status ?? "").toUpperCase();
    return s !== "RESULT" && s !== "CLOSED";
  });
}

export async function ingestOneMeeting(
  env: Env,
  rawMeeting: MeetingRaw,
  fullData?: RaceMeetingsFullData | null,
): Promise<{ date: string; venue: string; races: number; snapshots_changed: number }> {
  const meeting = normalizeMeeting(rawMeeting, "graphql");
  await persistMeetingTree(env.DB, meeting, rawMeeting);
  await storeChangeHistories(
    env.DB,
    meeting.meeting_date,
    meeting.venue,
    rawMeeting.changeHistories ?? [],
  );

  // Odds for all races in one call
  const oddsRes = await fetchGraphQL<PmPoolsOddsData>({
    query: QUERY_PM_POOLS_ODDS,
    variables: {
      date: meeting.meeting_date,
      venueCode: meeting.venue,
      oddsTypes: ["WIN", "PLA"],
      raceNo: 0,
    },
  });
  const pools = oddsRes.data?.raceMeetings?.[0]?.pmPools ?? [];
  const byRace = poolsByRace(pools);

  let changed = 0;
  const pushRaces: PushRace[] = [];
  const lockRaces: PushRace[] = [];
  const resultRaces: PushRace[] = [];
  let scratched = false;

  for (const race of meeting.races) {
    const pair = byRace.get(race.race_no);
    const snap = buildRaceOddsSnapshot({
      race: rawMeeting.races?.find((r) => r.no === race.race_no) ?? {
        no: race.race_no,
        runners: race.runners.map((r) => ({
          no: r.horse_no,
          name_en: r.name_en,
          status: r.status ?? undefined,
          finalPosition: r.final_position,
          winOdds: r.win_odds,
        })),
        postTime: race.post_time,
      },
      winPool: pair?.win,
      plaPool: pair?.pla,
    });

    const ins = await insertOddsSnapshotIfChanged(
      env.DB,
      meeting.meeting_date,
      meeting.venue,
      snap,
    );
    if (ins.inserted) {
      changed++;
      const pushRace: PushRace = {
        race_no: snap.race_no,
        post_time: snap.post_time,
        snapshot_time: snap.snapshot_time,
        pool_status: snap.pool_status,
        runners: snap.runners,
      };
      pushRaces.push(pushRace);
      if (snap.pool_status === "STOP_SELL") lockRaces.push(pushRace);
    }

    for (const r of race.runners) {
      if (isScratchedStatus(r.status)) scratched = true;
    }

    if (resultsComplete(race)) {
      resultRaces.push({
        race_no: race.race_no,
        post_time: race.post_time,
        snapshot_time: snap.snapshot_time,
        pool_status: snap.pool_status,
        runners: snap.runners,
      });
    }
  }

  // Official dividends for current meeting
  try {
    const divRes = await fetchGraphQL<ResultMeetingsData>({
      query: QUERY_RESULT_MEETINGS,
      variables: {
        date: meeting.meeting_date,
        venueCode: meeting.venue,
        resultOddsType: ["WIN", "PLA"],
        foOddsTypes: [],
        foFilter: [],
      },
    });
    const resPools = divRes.data?.raceMeetings?.[0]?.resPools ?? [];
    const divDoc = await storeRawDocument(
      env.DB,
      "graphql_dividends",
      `${meeting.meeting_date}_${meeting.venue}`,
      resPools,
      null,
    );
    const divByRace = new Map<number, typeof resPools>();
    for (const p of resPools) {
      const n = p.leg?.number ?? p.leg?.races?.[0];
      if (n == null) continue;
      const list = divByRace.get(n) ?? [];
      list.push(p);
      divByRace.set(n, list);
    }
    for (const [raceNo, racePools] of divByRace) {
      await storeDividendsAsResults(
        env.DB,
        meeting.meeting_date,
        meeting.venue,
        raceNo,
        racePools,
        "graphql",
      );
    }
    if (divDoc.changed && resPools.length > 0) {
      await sendPush(
        env,
        buildEnvelope({
          event: "dividends",
          meeting_date: meeting.meeting_date,
          venue: meeting.venue,
          meta: { content_hash: divDoc.content_hash, pools: resPools.length },
        }),
      );
    }
  } catch {
    // dividends optional
  }

  // Changes (full list)
  try {
    const chRes = await fetchGraphQL<RacingChangesData>({
      query: QUERY_RACING_CHANGES,
      variables: {},
    });
    for (const m of chRes.data?.raceMeetings ?? []) {
      if (m.date === meeting.meeting_date && m.venueCode === meeting.venue) {
        const n = await storeChangeHistories(
          env.DB,
          meeting.meeting_date,
          meeting.venue,
          m.changeHistories ?? [],
        );
        const chDoc = await storeRawDocument(
          env.DB,
          "graphql_changes",
          `${meeting.meeting_date}_${meeting.venue}`,
          m.changeHistories ?? [],
          null,
        );
        if (chDoc.changed && n > 0) {
          await sendPush(
            env,
            buildEnvelope({
              event: "changes",
              meeting_date: meeting.meeting_date,
              venue: meeting.venue,
              meta: { new_events: n, content_hash: chDoc.content_hash },
            }),
          );
        }
      }
    }
  } catch {
    // optional
  }

  if (pushRaces.length > 0) {
    const r = await sendPush(
      env,
      buildEnvelope({
        event: "odds_update",
        meeting_date: meeting.meeting_date,
        venue: meeting.venue,
        races: pushRaces,
      }),
    );
    if (r.success) {
      await setMeta(env.DB, "last_push_at", new Date().toISOString());
      await setMeta(env.DB, "last_push_status", String(r.http_status));
      await piggybackPending(env);
    }
  }

  if (lockRaces.length > 0) {
    await sendPush(
      env,
      buildEnvelope({
        event: "lock",
        meeting_date: meeting.meeting_date,
        venue: meeting.venue,
        races: lockRaces,
      }),
    );
  }

  if (scratched) {
    await sendPush(
      env,
      buildEnvelope({
        event: "scratch",
        meeting_date: meeting.meeting_date,
        venue: meeting.venue,
        races: pushRaces,
      }),
    );
  }

  if (resultRaces.length > 0) {
    await sendPush(
      env,
      buildEnvelope({
        event: "result",
        meeting_date: meeting.meeting_date,
        venue: meeting.venue,
        races: resultRaces,
      }),
    );
  }

  // Horse pages: once on first racecard sight + again on race day (not every poll)
  const todayHk = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const horseCodes = [
    ...new Set(
      (rawMeeting.races ?? [])
        .flatMap((r) => r.runners ?? [])
        .map((r) => r.horse?.code)
        .filter((c): c is string => !!c),
    ),
  ];
  if (horseCodes.length > 0) {
    await refreshMeetingHorses(env, {
      meeting_date: meeting.meeting_date,
      venue: meeting.venue,
      horse_codes: horseCodes,
      is_race_day: meeting.meeting_date === todayHk,
    });
  }

  void fullData;

  return {
    date: meeting.meeting_date,
    venue: meeting.venue,
    races: meeting.races.length,
    snapshots_changed: changed,
  };
}

export async function sendTestPush(env: Env): Promise<unknown> {
  // Use latest stored odds snapshot if available
  const row = await env.DB.prepare(
    `SELECT meeting_date, venue, race_no, snapshot_time, pool_status, raw_json
     FROM odds_snapshots ORDER BY id DESC LIMIT 1`,
  ).first<{
    meeting_date: string;
    venue: string;
    race_no: number;
    snapshot_time: string;
    pool_status: string | null;
    raw_json: string;
  }>();

  let races: PushRace[] = [];
  let meeting_date: string | null = null;
  let venue: string | null = null;

  if (row) {
    const data = JSON.parse(row.raw_json) as {
      race_no: number;
      post_time: string | null;
      snapshot_time: string;
      pool_status: string | null;
      runners: PushRace["runners"];
    };
    meeting_date = row.meeting_date;
    venue = row.venue;
    races = [
      {
        race_no: data.race_no,
        post_time: data.post_time,
        snapshot_time: data.snapshot_time,
        pool_status: data.pool_status,
        runners: data.runners,
      },
    ];
  }

  const envelope = buildEnvelope({
    event: "test",
    meeting_date,
    venue,
    races,
    meta: { note: "manual test push; LIVE_PUSH_ENABLED still gates live events" },
  });

  const result = await sendPush(env, envelope, { force: true });
  await setMeta(env.DB, "last_push_at", new Date().toISOString());
  await setMeta(env.DB, "last_push_status", String(result.http_status));
  return { envelope, result };
}
