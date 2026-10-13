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
  dividendsHashPayload,
  dividendsPoolCount,
  hasAnyDividends,
} from "../parse/dividends";
import {
  isStorableOddsSnapshot,
  shouldEmitLock,
  snapshotHasOdds,
} from "../parse/lock";
import {
  isScratchedStatus,
  normalizeMeeting,
  pickHkActiveMeetings,
  resultsComplete,
} from "../parse/meeting";
import { buildRaceOddsSnapshot, poolsByRace } from "../parse/odds";
import {
  computeOddsDeltaChanges,
  maxSourceTime,
  type HorseNamePair,
} from "../push/delta";
import { emitPush } from "../push/emit";
import { formatHkNow, type PushRace } from "../push/envelope";
import {
  decideFullSnapshotRaces,
  emitOddsUpdateIfChanged,
  enqueueOddsDeltaBatch,
  filterDeltaForPush,
  markFullSnapshots,
  maybeFlushOddsDeltaCoalesce,
} from "../push/odds-emit";
import {
  buildCompleteSnapshotRaces,
  snapshotToPushRace,
} from "../push/snapshot-coverage";
import {
  createRetryRunState,
  flushDueRetries,
  piggybackPending,
  type RetryRunState,
} from "../push/pusher";
import type { RaceOddsSnapshot } from "../parse/odds";
import {
  getMeta,
  insertOddsSnapshotIfChanged,
  persistMeetingTree,
  raceHadOpenOddsSnapshot,
  setMeta,
  storeChangeHistories,
  storeDividendsAsResults,
} from "../store/db";
import { runHorseCodeBackfill } from "./horse-code-backfill";
import { storeRawDocument } from "../store/horses";
import { createSubrequestBudget, type SubrequestBudget } from "../util/budget";
import { runStage } from "../util/stage";
import { rearmStalePollers } from "../poll/watchdog";
import { refreshMeetingHorses } from "./horses";

function namesForRace(snap: RaceOddsSnapshot): Map<string, HorseNamePair> {
  const map = new Map<string, HorseNamePair>();
  for (const r of snap.runners) {
    map.set(r.runner_id, {
      horse_name_en: r.horse_name,
      horse_name_ch: null,
    });
  }
  return map;
}

function toPushRace(snap: RaceOddsSnapshot): PushRace {
  return snapshotToPushRace(snap);
}

export async function ingestActiveMeeting(env: Env): Promise<{
  meetings: Array<{ date: string; venue: string; races: number; snapshots_changed: number }>;
  whitelist_error?: string;
  watchdog?: { checked: number; rearmed: number };
}> {
  // Retries share one budget and run AFTER new event pushes so live traffic
  // is not starved by a large legacy pending_pushes backlog.
  const retryState = createRetryRunState(env);
  const budget = createSubrequestBudget(env);
  const out: Array<{ date: string; venue: string; races: number; snapshots_changed: number }> = [];
  let whitelist_error: string | undefined;
  const liveMeetings: Array<{ date: string; venue: string }> = [];

  // One-shot D1-only backfill v2: meetings.raw_json + odds_snapshots.runner_id.
  // v1 only scanned meetings.raw_json (often rbcMeeting without horse.code) and
  // only ran on admin ingest — production runners stayed null. Prefer explicit
  // POST /v1/admin/backfill-horse-codes for full control.
  try {
    const done = await getMeta(env.DB, "horse_code_backfill_v2");
    if (done !== "1") {
      await runHorseCodeBackfill(env, { source: "store", limit_meetings: 100 });
      await setMeta(env.DB, "horse_code_backfill_v2", "1");
    }
  } catch (e) {
    console.error("horse_code backfill v2 failed", e);
  }

  try {
    const scheduleResult = await runStage(env, "schedule", async () => {
      budget.charge(1, { force: true });
      let data: RaceMeetingsFullData | null = null;
      try {
        const res = await fetchGraphQL<RaceMeetingsFullData>({
          query: QUERY_RACE_MEETINGS_FULL,
          variables: { date: "2026-10-07", venueCode: "HV" },
        });
        data = res.data ?? null;
      } catch (err) {
        if (err instanceof WhitelistError) {
          await setMeta(env.DB, "whitelist_error", err.message);
          await emitPush(
            env,
            {
              event: "whitelist_alert",
              meta: { message: err.message },
              source_last_updated_at: null,
            },
            { force: true },
          );
          return { data: null as RaceMeetingsFullData | null, whitelist: err.message };
        }
        throw err;
      }

      await setMeta(env.DB, "whitelist_error", "");
      await setMeta(env.DB, "last_fetch_at", new Date().toISOString());

      if (data) {
        await storeRawDocument(env.DB, "graphql_raceMeetings_full", "active", data, null, {
          env,
        });
      }
      return { data, whitelist: null as string | null };
    });

    if (!scheduleResult.ok) {
      return { meetings: out, whitelist_error: scheduleResult.error };
    }
    if (scheduleResult.value.whitelist) {
      return { meetings: out, whitelist_error: scheduleResult.value.whitelist };
    }

    const data = scheduleResult.value.data;
    const active = pickHkActiveMeetings(data?.activeMeetings);
    const raceMeetings = (data?.raceMeetings ?? []).filter((m) =>
      ["ST", "HV"].includes(m.venueCode),
    );

    const targets: MeetingRaw[] =
      raceMeetings.length > 0
        ? raceMeetings
        : active.map((a) => ({
            date: a.date,
            venueCode: a.venueCode,
            status: a.status,
            races: [],
          }));

    for (const rawMeeting of targets) {
      const meetingResult = await runStage(env, "odds", async () =>
        ingestOneMeeting(env, rawMeeting, data, retryState, budget),
      );
      if (meetingResult.ok) {
        out.push(meetingResult.value);
      }

      if (rawMeeting.status !== "CLOSED" || hasOpenRaces(rawMeeting)) {
        liveMeetings.push({ date: rawMeeting.date, venue: rawMeeting.venueCode });
        await runStage(env, "wake_do", async () => {
          budget.charge(1, { force: true });
          const id = env.MEETING_DO.idFromName(`${rawMeeting.date}_${rawMeeting.venueCode}`);
          const stub = env.MEETING_DO.get(id);
          await stub.fetch("https://do/start", {
            method: "POST",
            body: JSON.stringify({
              meeting_date: rawMeeting.date,
              venue: rawMeeting.venueCode,
            }),
          });
        });
      }
    }

    if (active.length > 0) {
      await runStage(env, "pushes", async () => {
        await emitPush(
          env,
          {
            event: "schedule",
            meta: {
              active: active.map((a) => ({
                date: a.date,
                venue: a.venueCode,
                status: a.status,
                races: a.races?.map((r) => ({ no: r.no, postTime: r.postTime, status: r.status })),
              })),
            },
            source_last_updated_at: null,
          },
          { force: true },
        );
      });
    }

    const watchdog = await runStage(env, "watchdog", async () =>
      rearmStalePollers(env, liveMeetings),
    );

    return {
      meetings: out,
      whitelist_error,
      watchdog: watchdog.ok ? watchdog.value : { checked: 0, rearmed: 0 },
    };
  } finally {
    await runStage(env, "retry_flush", async () => {
      await flushDueRetries(env, { retryState });
    });
  }
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
  retryState?: RetryRunState,
  budget?: SubrequestBudget,
): Promise<{ date: string; venue: string; races: number; snapshots_changed: number }> {
  const sub = budget ?? createSubrequestBudget(env);
  const meeting = normalizeMeeting(rawMeeting, "graphql");

  await runStage(env, "persist", async () => {
    await persistMeetingTree(env.DB, meeting, rawMeeting);
    await storeChangeHistories(
      env.DB,
      meeting.meeting_date,
      meeting.venue,
      rawMeeting.changeHistories ?? [],
    );
  });

  const captured_at = formatHkNow();

  let changed = 0;
  const pushRaces: PushRace[] = [];
  const lockRaces: PushRace[] = [];
  const resultRaces: PushRace[] = [];
  const allDeltaChanges: ReturnType<typeof computeOddsDeltaChanges> = [];
  const deltaRaceNos: number[] = [];
  const changedMeta: Array<{
    previous: RaceOddsSnapshot | null;
    next: RaceOddsSnapshot;
    pushRace: PushRace;
  }> = [];
  const sourceTimes: Array<string | null> = [];
  let scratched = false;
  const poolInvs = rawMeeting.poolInvs ?? [];
  const nowMs = Date.now();

  // Priority: odds fetch + lock/result enqueue
  await runStage(env, "odds", async () => {
    sub.charge(1, { force: true });
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

    for (const race of meeting.races) {
      const pair = byRace.get(race.race_no);
      const snap = buildRaceOddsSnapshot({
        race: rawMeeting.races?.find((r) => r.no === race.race_no) ?? {
          no: race.race_no,
          runners: race.runners.map((r) => ({
            no: r.horse_no,
            name_en: r.name_en,
            name_ch: r.name_ch,
            status: r.status ?? undefined,
            finalPosition: r.final_position,
            winOdds: r.win_odds,
          })),
          postTime: race.post_time,
        },
        winPool: pair?.win,
        plaPool: pair?.pla,
      });
      sourceTimes.push(snap.payload.last_update);

      if (isStorableOddsSnapshot(snap)) {
        const hadPriorOpen = await raceHadOpenOddsSnapshot(
          env.DB,
          meeting.meeting_date,
          meeting.venue,
          race.race_no,
        );

        const ins = await insertOddsSnapshotIfChanged(
          env.DB,
          meeting.meeting_date,
          meeting.venue,
          snap,
          "graphql",
          null,
          env,
        );
        if (ins.inserted) {
          changed++;
          const pushRace = toPushRace(snap);
          pushRaces.push(pushRace);
          deltaRaceNos.push(race.race_no);
          changedMeta.push({
            previous: ins.previous,
            next: snap,
            pushRace,
          });
          allDeltaChanges.push(
            ...computeOddsDeltaChanges({
              prev: ins.previous,
              next: snap,
              horseNames: namesForRace(snap),
            }),
          );
          if (
            shouldEmitLock({
              poolStatus: snap.pool_status,
              postTime: snap.post_time,
              nowMs,
              wasOpenOrHasOdds: snapshotHasOdds(snap) || hadPriorOpen,
            })
          ) {
            lockRaces.push(pushRace);
          }
        }
      }

      for (const r of race.runners) {
        if (isScratchedStatus(r.status)) scratched = true;
      }

      if (resultsComplete(race)) {
        resultRaces.push(toPushRace(snap));
      }
    }
  });

  const meetingSourceTime = maxSourceTime(sourceTimes);

  await runStage(env, "dividends", async () => {
    if (!sub.canAfford(1)) return;
    sub.charge(1);
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
      { hashOf: dividendsHashPayload(resPools), env },
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
    if (divDoc.changed && hasAnyDividends(resPools)) {
      await emitPush(env, {
        event: "dividends",
        meeting_date: meeting.meeting_date,
        venue: meeting.venue,
        captured_at,
        source_last_updated_at: null,
        meta: {
          content_hash: divDoc.content_hash,
          pools: dividendsPoolCount(resPools),
        },
      });
    }
  });

  await runStage(env, "changes", async () => {
    if (!sub.canAfford(1)) return;
    sub.charge(1);
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
          { env },
        );
        if (chDoc.changed && n > 0) {
          await emitPush(env, {
            event: "changes",
            meeting_date: meeting.meeting_date,
            venue: meeting.venue,
            captured_at,
            source_last_updated_at: null,
            meta: { new_events: n, content_hash: chDoc.content_hash },
          });
        }
      }
    }
  });

  // Priority pushes: odds_delta (coalesced) + gated odds_update / lock / result
  await runStage(env, "pushes", async () => {
    let piggybackOk = false;
    if (allDeltaChanges.length > 0) {
      const gated = await filterDeltaForPush(
        env,
        meeting.meeting_date,
        meeting.venue,
        allDeltaChanges,
      );
      if (gated) {
        // Ingest is one-shot (no DO buffer): force-flush after enqueue.
        const buf = await enqueueOddsDeltaBatch(env, null, {
          meeting_date: meeting.meeting_date,
          venue: meeting.venue,
          nowMs,
          captured_at,
          sample_interval_s: null,
          changes: gated.changes,
          races: pushRaces,
          race_nos: deltaRaceNos,
          source_last_updated_at: meetingSourceTime,
        });
        const flushed = await maybeFlushOddsDeltaCoalesce(env, buf, {
          meeting_date: meeting.meeting_date,
          venue: meeting.venue,
          poolInvs,
          nowMs,
          force: true,
        });
        piggybackOk = flushed.flushed;
      }
    }

    const dueFull = decideFullSnapshotRaces({
      env,
      nowMs,
      lastFullByRace: {},
      changed: changedMeta,
    });
    if (dueFull.length > 0) {
      const { races: completeRaces, meta: coverage } =
        await buildCompleteSnapshotRaces({
          env,
          meeting_date: meeting.meeting_date,
          venue: meeting.venue,
          expectedRaceNos: meeting.races.map((r) => r.race_no),
          available: pushRaces.length > 0 ? pushRaces : dueFull,
        });
      const sent = await emitOddsUpdateIfChanged({
        env,
        meeting_date: meeting.meeting_date,
        venue: meeting.venue,
        races: completeRaces,
        captured_at,
        sample_interval_s: null,
        source_last_updated_at: meetingSourceTime,
        meta: {
          ...coverage,
          trigger_race_nos: dueFull.map((x) => x.race_no),
        },
      });
      if (sent.emitted) {
        markFullSnapshots({}, completeRaces, nowMs);
        piggybackOk = true;
      }
    }

    if (piggybackOk) {
      await piggybackPending(env, { retryState });
    }

    if (lockRaces.length > 0) {
      await emitPush(env, {
        event: "lock",
        meeting_date: meeting.meeting_date,
        venue: meeting.venue,
        races: lockRaces,
        captured_at,
        source_last_updated_at: meetingSourceTime,
      });
    }

    if (scratched) {
      await emitPush(env, {
        event: "scratch",
        meeting_date: meeting.meeting_date,
        venue: meeting.venue,
        races: pushRaces,
        captured_at,
        source_last_updated_at: meetingSourceTime,
      });
    }

    if (resultRaces.length > 0) {
      await emitPush(env, {
        event: "result",
        meeting_date: meeting.meeting_date,
        venue: meeting.venue,
        races: resultRaces,
        captured_at,
        source_last_updated_at: meetingSourceTime,
      });
    }
  });

  // Heavy horse/runs/injury — defer when subrequest budget is low
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
    await runStage(env, "horses", async () => {
      if (sub.shouldDeferHeavy()) {
        await setMeta(
          env.DB,
          "stage_error_horses",
          `deferred: subrequest budget remaining=${sub.remaining()}`,
        );
        return;
      }
      await refreshMeetingHorses(env, {
        meeting_date: meeting.meeting_date,
        venue: meeting.venue,
        horse_codes: horseCodes,
        is_race_day: meeting.meeting_date === todayHk,
        budget: sub,
      });
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
  let source_last_updated_at: string | null = null;

  if (row) {
    const data = JSON.parse(row.raw_json) as {
      race_no: number;
      post_time: string | null;
      snapshot_time: string;
      pool_status: string | null;
      runners: PushRace["runners"];
      payload?: { last_update: string | null };
    };
    meeting_date = row.meeting_date;
    venue = row.venue;
    source_last_updated_at = data.payload?.last_update ?? null;
    races = [
      {
        race_no: data.race_no,
        post_time: data.post_time,
        snapshot_time: data.snapshot_time,
        pool_status: data.pool_status,
        source_last_updated_at: data.payload?.last_update ?? null,
        runners: data.runners,
      },
    ];
  }

  const { envelope, result } = await emitPush(
    env,
    {
      event: "test",
      meeting_date,
      venue,
      races,
      source_last_updated_at,
      meta: { note: "manual test push; LIVE_PUSH_ENABLED still gates live events" },
    },
    { force: true },
  );
  // markLastPush happens inside successful delivery; keep meta for queued path
  if (result.queued || result.success) {
    await setMeta(env.DB, "last_push_at", new Date().toISOString());
    await setMeta(
      env.DB,
      "last_push_status",
      result.queued ? "queued" : String(result.http_status),
    );
  }
  return { envelope, result };
}
