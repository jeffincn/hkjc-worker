import type { Env } from "../env";
import { envNum } from "../env";
import { fetchGraphQL } from "../graphql/client";
import { QUERY_PM_POOLS_ODDS, QUERY_RACE_MEETINGS_FULL } from "../graphql/queries";
import type { MeetingRaw, PmPoolsOddsData, RaceMeetingsFullData } from "../graphql/types";
import {
  isStorableOddsSnapshot,
  shouldEmitLock,
  snapshotHasOdds,
} from "../parse/lock";
import { normalizeMeeting, resultsComplete } from "../parse/meeting";
import { buildRaceOddsSnapshot, poolsByRace } from "../parse/odds";
import type { RaceOddsSnapshot } from "../parse/odds";
import {
  buildPoolInvestments,
  computeOddsDeltaChanges,
  maxSourceTime,
  type HorseNamePair,
} from "../push/delta";
import { emitPush } from "../push/emit";
import type { PushRace } from "../push/envelope";
import { formatHkNow } from "../push/envelope";
import { isInFastWindow, shouldEmitNoUpdate } from "../push/heartbeat";
import { getLastChange } from "../push/seq";
import {
  insertOddsSnapshotIfChanged,
  meetingTreeContentHash,
  persistMeetingTree,
  raceHadOpenOddsSnapshot,
  setMeta,
} from "../store/db";
import { createSubrequestBudget } from "../util/budget";
import { runStage } from "../util/stage";
import { computePollIntervalMs, selectRelevantPostTime } from "./interval";

interface DoState {
  meeting_date: string;
  venue: string;
  locked_races: number[];
  result_races: number[];
}

const LAST_FETCH_D1_FLUSH_MS = 5 * 60 * 1000;
/** Fallback reschedule when interval cannot be computed (errors / missing data). */
const ERROR_RESCHEDULE_MS = 60_000;

function namesForRace(
  meeting: ReturnType<typeof normalizeMeeting>,
  raceNo: number,
): Map<number, HorseNamePair> {
  const map = new Map<number, HorseNamePair>();
  const race = meeting.races.find((r) => r.race_no === raceNo);
  for (const r of race?.runners ?? []) {
    map.set(r.horse_no, {
      horse_name_en: r.name_en ?? null,
      horse_name_ch: r.name_ch ?? null,
    });
  }
  return map;
}

function toPushRace(snap: RaceOddsSnapshot): PushRace {
  return {
    race_no: snap.race_no,
    post_time: snap.post_time,
    snapshot_time: snap.snapshot_time,
    pool_status: snap.pool_status,
    source_last_updated_at: snap.payload.last_update,
    runners: snap.runners.map((r) => ({
      horse_no: r.horse_no,
      horse_name: r.horse_name,
      win_odds: r.win_odds,
      place_odds: r.place_odds,
      status: r.status,
      final_position: r.final_position,
    })),
  };
}

/**
 * One Durable Object per meeting. Alarm self-loop:
 * 60 min when >24h before post, 5 min when 2–24h, 60s when 30min–2h,
 * 30s inside 30min.
 *
 * Every alarm invocation ALWAYS reschedules itself (unless meeting is fully
 * done), even when individual stages throw.
 */
export class MeetingPoller implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/start")) {
      const body = (await request.json()) as { meeting_date: string; venue: string };
      // Hourly cron re-starts pollers for live meetings. Preserve the
      // locked/result memory for the same meeting so restarts do not
      // re-push lock/result events that were already delivered.
      const existing = await this.state.storage.get<DoState>("cfg");
      const sameMeeting =
        existing?.meeting_date === body.meeting_date && existing?.venue === body.venue;
      await this.state.storage.put<DoState>("cfg", {
        meeting_date: body.meeting_date,
        venue: body.venue,
        locked_races: sameMeeting ? (existing?.locked_races ?? []) : [],
        result_races: sameMeeting ? (existing?.result_races ?? []) : [],
      });
      await this.state.storage.setAlarm(Date.now() + 1000);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/status")) {
      const cfg = await this.state.storage.get<DoState>("cfg");
      const alarm = await this.state.storage.getAlarm();
      const lastFetchAt = await this.state.storage.get<string>("last_fetch_at");
      const lastError = await this.state.storage.get<string>("last_alarm_error");
      return new Response(
        JSON.stringify({
          cfg,
          alarm,
          last_fetch_at: lastFetchAt ?? null,
          last_alarm_error: lastError ?? null,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const cfg = await this.state.storage.get<DoState>("cfg");
    if (!cfg) return;

    const fastSec = envNum(this.env, "POLL_INTERVAL_SEC", 30);
    const captured_at = formatHkNow();
    const budget = createSubrequestBudget(this.env);
    let stopPolling = false;
    let nextIntervalMs = ERROR_RESCHEDULE_MS;

    try {
      const schedule = await runStage(this.env, "schedule", async () => {
        budget.charge(1, { force: true });
        const full = await fetchGraphQL<RaceMeetingsFullData>({
          query: QUERY_RACE_MEETINGS_FULL,
          variables: { date: cfg.meeting_date, venueCode: cfg.venue },
        });
        const found =
          (full.data?.raceMeetings ?? []).find(
            (m) => m.date === cfg.meeting_date && m.venueCode === cfg.venue,
          ) ??
          full.data?.raceMeetings?.[0] ??
          null;

        if (!found) {
          return null as {
            meeting: ReturnType<typeof normalizeMeeting>;
            raw: MeetingRaw;
          } | null;
        }

        if (found.date !== cfg.meeting_date || found.venueCode !== cfg.venue) {
          cfg.meeting_date = found.date;
          cfg.venue = found.venueCode;
          await this.state.storage.put("cfg", cfg);
        }

        const meeting = normalizeMeeting(found, "graphql");
        const treeHash = await meetingTreeContentHash(meeting);
        const prevHash = await this.state.storage.get<string>("meeting_tree_hash");
        if (treeHash !== prevHash) {
          await persistMeetingTree(this.env.DB, meeting, found);
          await this.state.storage.put("meeting_tree_hash", treeHash);
        }

        await this.touchLastFetchAt();
        return { meeting, raw: found };
      });

      if (!schedule.ok || !schedule.value) {
        nextIntervalMs = ERROR_RESCHEDULE_MS;
        return;
      }

      const { meeting, raw } = schedule.value;
      const changed: PushRace[] = [];
      const allDeltaChanges: ReturnType<typeof computeOddsDeltaChanges> = [];
      const deltaRaceNos: number[] = [];
      const sourceTimes: Array<string | null> = [];
      const nowMs = Date.now();
      const poolInvs = raw.poolInvs ?? [];

      await runStage(this.env, "odds", async () => {
        budget.charge(1, { force: true });
        const oddsRes = await fetchGraphQL<PmPoolsOddsData>({
          query: QUERY_PM_POOLS_ODDS,
          variables: {
            date: meeting.meeting_date,
            venueCode: meeting.venue,
            oddsTypes: ["WIN", "PLA"],
            raceNo: 0,
          },
        });
        const byRace = poolsByRace(oddsRes.data?.raceMeetings?.[0]?.pmPools ?? []);

        for (const race of meeting.races) {
          const pair = byRace.get(race.race_no);
          const snap = buildRaceOddsSnapshot({
            race: raw.races?.find((r) => r.no === race.race_no) ?? {
              no: race.race_no,
              postTime: race.post_time,
              runners: [],
            },
            winPool: pair?.win,
            plaPool: pair?.pla,
          });
          sourceTimes.push(snap.payload.last_update);
          const pushRace = toPushRace(snap);

          if (isStorableOddsSnapshot(snap)) {
            const hadPriorOpen = await raceHadOpenOddsSnapshot(
              this.env.DB,
              meeting.meeting_date,
              meeting.venue,
              race.race_no,
            );
            const ins = await insertOddsSnapshotIfChanged(
              this.env.DB,
              meeting.meeting_date,
              meeting.venue,
              snap,
            );
            if (ins.inserted) {
              changed.push(pushRace);
              deltaRaceNos.push(race.race_no);
              const delta = computeOddsDeltaChanges({
                prev: ins.previous,
                next: snap,
                horseNames: namesForRace(meeting, race.race_no),
              });
              allDeltaChanges.push(...delta);
            }

            if (
              !cfg.locked_races.includes(race.race_no) &&
              shouldEmitLock({
                poolStatus: snap.pool_status,
                postTime: snap.post_time,
                nowMs,
                wasOpenOrHasOdds: snapshotHasOdds(snap) || hadPriorOpen,
              })
            ) {
              cfg.locked_races.push(race.race_no);
              await runStage(this.env, "pushes", async () => {
                await emitPush(this.env, {
                  event: "lock",
                  meeting_date: meeting.meeting_date,
                  venue: meeting.venue,
                  races: [pushRace],
                  captured_at,
                  source_last_updated_at: snap.payload.last_update,
                });
              });
            }
          }

          if (resultsComplete(race) && !cfg.result_races.includes(race.race_no)) {
            cfg.result_races.push(race.race_no);
            await runStage(this.env, "pushes", async () => {
              await emitPush(this.env, {
                event: "result",
                meeting_date: meeting.meeting_date,
                venue: meeting.venue,
                races: [pushRace],
                captured_at,
                source_last_updated_at: snap.payload.last_update,
              });
            });
          }
        }
      });

      const meetingSourceTime = maxSourceTime(sourceTimes);

      await runStage(this.env, "pushes", async () => {
        if (changed.length > 0) {
          await emitPush(this.env, {
            event: "odds_update",
            meeting_date: meeting.meeting_date,
            venue: meeting.venue,
            races: changed,
            captured_at,
            source_last_updated_at: meetingSourceTime,
          });

          if (allDeltaChanges.length > 0) {
            await emitPush(this.env, {
              event: "odds_delta",
              meeting_date: meeting.meeting_date,
              venue: meeting.venue,
              races: changed,
              changes: allDeltaChanges,
              pools: buildPoolInvestments(poolInvs, deltaRaceNos),
              captured_at,
              source_last_updated_at: meetingSourceTime,
            });
          }
        } else {
          const post = selectRelevantPostTime(
            meeting.races.map((r) => ({ post_time: r.post_time, status: r.status })),
            nowMs,
          );
          const fast = isInFastWindow(post, nowMs);
          const lastNoUpdateAtMs =
            (await this.state.storage.get<number>("last_no_update_at_ms")) ?? null;
          if (shouldEmitNoUpdate({ nowMs, lastNoUpdateAtMs, inFastWindow: fast })) {
            const last = await getLastChange(
              this.env,
              meeting.meeting_date,
              meeting.venue,
            );
            await emitPush(this.env, {
              event: "no_update",
              meeting_date: meeting.meeting_date,
              venue: meeting.venue,
              races: [],
              captured_at,
              source_last_updated_at: meetingSourceTime,
              last_change_seq: last.last_change_seq,
              last_change_at: last.last_change_at,
            });
            await this.state.storage.put("last_no_update_at_ms", nowMs);
          }
        }
      });

      await this.state.storage.put("cfg", cfg);
      await this.state.storage.delete("last_alarm_error");

      const allDone =
        meeting.status === "CLOSED" ||
        meeting.races.every((r) => cfg.result_races.includes(r.race_no));

      if (allDone) {
        stopPolling = true;
        return;
      }

      const post = selectRelevantPostTime(
        meeting.races.map((r) => ({ post_time: r.post_time, status: r.status })),
        Date.now(),
      );
      nextIntervalMs = computePollIntervalMs({
        nowMs: Date.now(),
        postTimeIso: post,
        fastIntervalSec: fastSec,
        slowIntervalSec: 60,
        idleIntervalSec: 300,
      });
    } catch (err) {
      console.error("MeetingPoller alarm error", err);
      const message = err instanceof Error ? err.message : String(err);
      await this.state.storage.put("last_alarm_error", message.slice(0, 500));
      try {
        await setMeta(this.env.DB, "stage_error_odds", message.slice(0, 500));
      } catch {
        // ignore meta write failure
      }
      nextIntervalMs = ERROR_RESCHEDULE_MS;
    } finally {
      // ALWAYS reschedule unless the meeting is fully done.
      if (!stopPolling) {
        try {
          await this.state.storage.setAlarm(Date.now() + nextIntervalMs);
        } catch (alarmErr) {
          console.error("MeetingPoller failed to reschedule alarm", alarmErr);
        }
      }
    }
  }

  /** Always keep last_fetch_at in DO storage; flush to D1 at most every 5 minutes. */
  private async touchLastFetchAt(): Promise<void> {
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    await this.state.storage.put("last_fetch_at", nowIso);

    const lastFlush = await this.state.storage.get<number>("last_fetch_at_d1_ms");
    if (lastFlush != null && nowMs - lastFlush < LAST_FETCH_D1_FLUSH_MS) {
      return;
    }
    await setMeta(this.env.DB, "last_fetch_at", nowIso);
    await this.state.storage.put("last_fetch_at_d1_ms", nowMs);
  }
}
