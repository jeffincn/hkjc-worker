import type { Env } from "../env";
import { fetchGraphQL, SourceBlockedError } from "../graphql/client";
import { QUERY_PM_POOLS_ODDS, QUERY_RACE_MEETINGS_FULL } from "../graphql/queries";
import type { MeetingRaw, PmPoolsOddsData, RaceMeetingsFullData } from "../graphql/types";
import {
  isOpenSellStatus,
  isStorableOddsSnapshot,
  shouldEmitLock,
  snapshotHasOdds,
} from "../parse/lock";
import { normalizeMeeting, resultsComplete } from "../parse/meeting";
import { buildRaceOddsSnapshot, poolsByRace } from "../parse/odds";
import type { RaceOddsSnapshot } from "../parse/odds";
import {
  computeOddsDeltaChanges,
  maxSourceTime,
  type HorseNamePair,
} from "../push/delta";
import { emitPush } from "../push/emit";
import type { PushRace } from "../push/envelope";
import { formatHkNow } from "../push/envelope";
import {
  decideFullSnapshotRaces,
  emitIdleKeepalive,
  enqueueOddsDeltaBatch,
  markFullSnapshots,
  maybeFlushOddsDeltaCoalesce,
  type FullSnapshotByRace,
} from "../push/odds-emit";
import { buildCompleteSnapshotRaces, snapshotToPushRace } from "../push/snapshot-coverage";
import {
  finalRaceNo,
  firstRacePostMs,
  isInRaceDayHighFreqWindow,
  pushCoalesceMs,
  racedayWindowBeforeSec,
  type CoalesceBuffer,
} from "../push/odds-policy";
import {
  insertOddsSnapshotIfChanged,
  meetingTreeContentHash,
  persistMeetingTree,
  raceHadOpenOddsSnapshot,
  raceHasPublishedDividends,
  setMeta,
} from "../store/db";
import { addGraphqlUsage } from "../store/usage";
import { createSubrequestBudget } from "../util/budget";
import { runStage } from "../util/stage";
import { computePollIntervalMs, selectRelevantPostTime } from "./interval";
import {
  backoffIntervalMs,
  effectiveIntervalMs,
  HEALTHY_BLOCK_STATE,
  hkDay,
  nextBlockState,
  resolveDailyRequestBudget,
  resolvePollIntervalMs,
  throttleIntervalMs,
  type BlockState,
  type FetchOutcome,
} from "./live";

interface UsageState {
  day: string;
  /** Requests counted locally but not yet flushed to D1. */
  pending: number;
  /** Last known D1 total for `day` (all pollers). */
  global: number;
  flushed_at_ms: number;
}

const USAGE_FLUSH_MS = 60_000;
/** Minimum gap between alarm end and next tick. */
const MIN_ALARM_GAP_MS = 250;
/** Expected meeting end = last post time + this. */
const MEETING_TAIL_MS = 30 * 60 * 1000;

function classifyFetchError(err: unknown): FetchOutcome {
  if (err instanceof SourceBlockedError) return { kind: "blocked", reason: err.kind };
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "error", reason: message.slice(0, 200) };
}

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
  snap?: RaceOddsSnapshot,
): Map<string, HorseNamePair> {
  const map = new Map<string, HorseNamePair>();
  // Prefer snapshot runner_ids (stable); meeting tree alone is cloth-keyed.
  if (snap) {
    for (const r of snap.runners) {
      map.set(r.runner_id, {
        horse_name_en: r.horse_name,
        horse_name_ch: null,
      });
    }
  }
  const race = meeting.races.find((r) => r.race_no === raceNo);
  for (const r of race?.runners ?? []) {
    // Fill Chinese names when cloth matches a declared runner already in map.
    for (const [id, pair] of map) {
      if (pair.horse_name_en && r.name_en && pair.horse_name_en === r.name_en) {
        map.set(id, {
          horse_name_en: r.name_en ?? pair.horse_name_en,
          horse_name_ch: r.name_ch ?? pair.horse_name_ch,
        });
      }
    }
  }
  return map;
}

function toPushRace(snap: RaceOddsSnapshot): PushRace {
  return snapshotToPushRace(snap);
}

/**
 * One Durable Object per meeting. Alarm self-loop:
 * 60 min when >24h before post, 5 min when 2–24h, 60s when 30min–2h,
 * POLL_INTERVAL_MS (default 3s) inside 30min or whenever any unfinished race
 * has open WIN/PLA betting. Effective interval is stretched by the daily
 * GraphQL budget throttle and source-block backoff (see ./live.ts).
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
      const blockState = await this.state.storage.get<BlockState>("block_state");
      const usage = await this.state.storage.get<UsageState>("gql_usage");
      const currentIntervalMs = await this.state.storage.get<number>("current_interval_ms");
      return new Response(
        JSON.stringify({
          cfg,
          alarm,
          last_fetch_at: lastFetchAt ?? null,
          last_alarm_error: lastError ?? null,
          current_interval_ms: currentIntervalMs ?? null,
          source_block: blockState ?? HEALTHY_BLOCK_STATE,
          graphql_requests_today: usage ? { day: usage.day, count: usage.global + usage.pending } : null,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const cfg = await this.state.storage.get<DoState>("cfg");
    if (!cfg) return;

    const tickStartMs = Date.now();
    const liveMs = resolvePollIntervalMs(this.env);
    const prevIntervalMs =
      (await this.state.storage.get<number>("current_interval_ms")) ?? liveMs;
    // Interval actually in effect for this capture (gap since previous tick).
    const sample_interval_s = prevIntervalMs / 1000;
    const captured_at = formatHkNow();
    const budget = createSubrequestBudget(this.env);
    let stopPolling = false;
    let nextIntervalMs = ERROR_RESCHEDULE_MS;
    let gqlAttempts = 0;
    const onAttempt = () => {
      gqlAttempts++;
    };
    let fetchOutcome: FetchOutcome = { kind: "ok" };
    const onFetchError = (err: unknown) => {
      fetchOutcome = classifyFetchError(err);
    };
    let horizonEndMs: number | null = null;
    let meetingKey: { meeting_date: string; venue: string } = {
      meeting_date: cfg.meeting_date,
      venue: cfg.venue,
    };

    try {
      const schedule = await runStage(this.env, "schedule", async () => {
        budget.charge(1, { force: true });
        const full = await fetchGraphQL<RaceMeetingsFullData>({
          query: QUERY_RACE_MEETINGS_FULL,
          variables: { date: cfg.meeting_date, venueCode: cfg.venue },
          onAttempt,
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
      }, { onError: onFetchError });

      if (!schedule.ok || !schedule.value) {
        // Fetch failure: keep the previous schedule cadence and let backoff
        // stretch it; missing meeting (no fetch error) uses the slow fallback.
        nextIntervalMs = !schedule.ok
          ? ((await this.state.storage.get<number>("last_schedule_ms")) ?? ERROR_RESCHEDULE_MS)
          : ERROR_RESCHEDULE_MS;
        return;
      }

      const { meeting, raw } = schedule.value;
      const changed: PushRace[] = [];
      const allDeltaChanges: ReturnType<typeof computeOddsDeltaChanges> = [];
      const deltaRaceNos: number[] = [];
      const sourceTimes: Array<string | null> = [];
      const nowMs = Date.now();
      const poolInvs = raw.poolInvs ?? [];
      let bettingOpen = false;
      meetingKey = { meeting_date: meeting.meeting_date, venue: meeting.venue };
      const postMsList = meeting.races
        .map((r) => (r.post_time ? Date.parse(r.post_time) : NaN))
        .filter((t) => Number.isFinite(t));
      horizonEndMs = postMsList.length > 0 ? Math.max(...postMsList) + MEETING_TAIL_MS : null;

      const changedMeta: Array<{
        previous: RaceOddsSnapshot | null;
        next: RaceOddsSnapshot;
        pushRace: PushRace;
      }> = [];
      const latestRaces: PushRace[] = [];
      let anyPushThisTick = false;

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
          onAttempt,
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
          if (!resultsComplete(race) && isOpenSellStatus(snap.pool_status)) {
            bettingOpen = true;
          }
          const pushRace = toPushRace(snap);

          if (isStorableOddsSnapshot(snap)) {
            latestRaces.push(pushRace);
            const alreadyLocked = cfg.locked_races.includes(race.race_no);
            // Only needed for lock detection; skip the D1 read once locked.
            const hadPriorOpen = alreadyLocked
              ? true
              : await raceHadOpenOddsSnapshot(
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
              "graphql",
              sample_interval_s,
            );
            if (ins.inserted) {
              changed.push(pushRace);
              deltaRaceNos.push(race.race_no);
              changedMeta.push({
                previous: ins.previous,
                next: snap,
                pushRace,
              });
              const delta = computeOddsDeltaChanges({
                prev: ins.previous,
                next: snap,
                horseNames: namesForRace(meeting, race.race_no, snap),
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
                  sample_interval_s,
                  source_last_updated_at: snap.payload.last_update,
                });
                anyPushThisTick = true;
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
                sample_interval_s,
                source_last_updated_at: snap.payload.last_update,
              });
              anyPushThisTick = true;
            });
          }
        }
      }, { onError: onFetchError });

      const meetingSourceTime = maxSourceTime(sourceTimes);

      await runStage(this.env, "pushes", async () => {
        let lastFullByRace =
          (await this.state.storage.get<FullSnapshotByRace>(
            "last_full_snapshot_by_race",
          )) ?? {};
        let coalesceBuf =
          (await this.state.storage.get<CoalesceBuffer>("odds_coalesce_buffer")) ??
          null;
        let lastAnyPushAtMs =
          (await this.state.storage.get<number>("last_any_push_at_ms")) ?? null;

        // Flush coalesce window opened on a prior tick.
        {
          const flushed = await maybeFlushOddsDeltaCoalesce(
            this.env,
            coalesceBuf,
            {
              meeting_date: meeting.meeting_date,
              venue: meeting.venue,
              poolInvs,
              nowMs,
            },
          );
          coalesceBuf = flushed.buffer;
          if (flushed.flushed) anyPushThisTick = true;
        }

        if (allDeltaChanges.length > 0) {
          coalesceBuf = await enqueueOddsDeltaBatch(this.env, coalesceBuf, {
            meeting_date: meeting.meeting_date,
            venue: meeting.venue,
            nowMs,
            captured_at,
            sample_interval_s,
            changes: allDeltaChanges,
            races: changed,
            race_nos: deltaRaceNos,
            source_last_updated_at: meetingSourceTime,
          });

          // With POLL_INTERVAL_MS (3s) > PUSH_COALESCE_MS (2s), flush this tick
          // so deltas are not held across a full poll interval. Shorter polls
          // keep the buffer until the window elapses.
          const coalesceMs = pushCoalesceMs(this.env);
          const forceFlush =
            coalesceMs <= 0 ||
            (await this.state.storage.get<number>("current_interval_ms")) ===
              undefined ||
            prevIntervalMs >= coalesceMs;
          const flushed = await maybeFlushOddsDeltaCoalesce(
            this.env,
            coalesceBuf,
            {
              meeting_date: meeting.meeting_date,
              venue: meeting.venue,
              poolInvs,
              nowMs,
              force: forceFlush,
            },
          );
          coalesceBuf = flushed.buffer;
          if (flushed.flushed) anyPushThisTick = true;
        }

        const dueFull = decideFullSnapshotRaces({
          env: this.env,
          nowMs,
          lastFullByRace,
          changed: changedMeta,
        });
        // Root cause of incomplete seq327/329: we previously emitted only the
        // due/changed subset. Always send a meeting-complete races[] (live +
        // D1 fill) with covered_races / missing_races / race_source_ts.
        if (dueFull.length > 0) {
          const expectedRaceNos = meeting.races.map((r) => r.race_no);
          const { races: completeRaces, meta: coverage } =
            await buildCompleteSnapshotRaces({
              env: this.env,
              meeting_date: meeting.meeting_date,
              venue: meeting.venue,
              expectedRaceNos,
              available: latestRaces.length > 0 ? latestRaces : dueFull,
            });
          await emitPush(this.env, {
            event: "odds_update",
            meeting_date: meeting.meeting_date,
            venue: meeting.venue,
            races: completeRaces,
            captured_at,
            sample_interval_s,
            source_last_updated_at: meetingSourceTime,
            meta: {
              ...coverage,
              trigger_race_nos: dueFull.map((r) => r.race_no),
            },
          });
          lastFullByRace = markFullSnapshots(
            lastFullByRace,
            completeRaces,
            nowMs,
          );
          anyPushThisTick = true;
        }

        if (!anyPushThisTick && changed.length === 0) {
          const lastNo = finalRaceNo(meeting.races);
          const finalDivs =
            lastNo == null
              ? false
              : ((await this.state.storage.get<boolean>(
                  "final_dividends_published",
                )) ??
                (await raceHasPublishedDividends(
                  this.env.DB,
                  meeting.meeting_date,
                  meeting.venue,
                  lastNo,
                )));
          if (finalDivs) {
            await this.state.storage.put("final_dividends_published", true);
          }
          const inHighFreqWindow = isInRaceDayHighFreqWindow({
            nowMs,
            firstPostMs: firstRacePostMs(meeting.races),
            finalDividendsPublished: finalDivs,
            windowBeforeSec: racedayWindowBeforeSec(this.env),
          });
          const idle = await emitIdleKeepalive({
            env: this.env,
            nowMs,
            lastAnyPushAtMs,
            lastFullByRace,
            meeting_date: meeting.meeting_date,
            venue: meeting.venue,
            captured_at,
            sample_interval_s,
            source_last_updated_at: meetingSourceTime,
            latestRaces,
            expectedRaceNos: meeting.races.map((r) => r.race_no),
            inHighFreqWindow,
          });
          lastFullByRace = idle.lastFullByRace;
          if (idle.emitted) anyPushThisTick = true;
        }

        if (anyPushThisTick) {
          lastAnyPushAtMs = nowMs;
        }

        await this.state.storage.put("last_full_snapshot_by_race", lastFullByRace);
        if (coalesceBuf && coalesceBuf.batches.length > 0) {
          await this.state.storage.put("odds_coalesce_buffer", coalesceBuf);
          // Wake before next poll if coalesce deadline is sooner.
          const coalesceMs = pushCoalesceMs(this.env);
          if (coalesceMs > 0) {
            const deadline = coalesceBuf.opened_at_ms + coalesceMs;
            await this.state.storage.put("odds_coalesce_deadline_ms", deadline);
          }
        } else {
          await this.state.storage.delete("odds_coalesce_buffer");
          await this.state.storage.delete("odds_coalesce_deadline_ms");
        }
        if (lastAnyPushAtMs != null) {
          await this.state.storage.put("last_any_push_at_ms", lastAnyPushAtMs);
        }
      });

      await this.state.storage.put("cfg", cfg);
      await this.state.storage.delete("last_alarm_error");

      const allDone =
        meeting.status === "CLOSED" ||
        meeting.races.every((r) => cfg.result_races.includes(r.race_no));

      if (allDone) {
        // Drain any buffered odds_delta before stopping the poller.
        const pending =
          (await this.state.storage.get<CoalesceBuffer>("odds_coalesce_buffer")) ??
          null;
        if (pending && pending.batches.length > 0) {
          await maybeFlushOddsDeltaCoalesce(this.env, pending, {
            meeting_date: meeting.meeting_date,
            venue: meeting.venue,
            poolInvs,
            nowMs: Date.now(),
            force: true,
          });
          await this.state.storage.delete("odds_coalesce_buffer");
          await this.state.storage.delete("odds_coalesce_deadline_ms");
        }
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
        liveIntervalMs: liveMs,
        bettingOpen,
        slowIntervalSec: 60,
        idleIntervalSec: 300,
      });
      await this.state.storage.put("last_schedule_ms", nextIntervalMs);
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
      let effectiveMs = nextIntervalMs;
      try {
        effectiveMs = await this.applyLiveControls({
          nowMs: Date.now(),
          liveMs,
          scheduleMs: nextIntervalMs,
          gqlAttempts,
          fetchOutcome,
          horizonEndMs,
          meetingKey,
          captured_at,
          sample_interval_s,
        });
      } catch (ctlErr) {
        console.error("MeetingPoller live control error", ctlErr);
      }
      // ALWAYS reschedule unless the meeting is fully done.
      if (!stopPolling) {
        try {
          // Fixed cadence from tick start (no drift by work duration).
          let at = Math.max(tickStartMs + effectiveMs, Date.now() + MIN_ALARM_GAP_MS);
          // If an odds_delta coalesce window is open, wake at the deadline so
          // we flush without waiting for the next poll interval.
          const coalesceDeadline = await this.state.storage.get<number>(
            "odds_coalesce_deadline_ms",
          );
          if (
            coalesceDeadline != null &&
            Number.isFinite(coalesceDeadline) &&
            coalesceDeadline < at
          ) {
            at = Math.max(coalesceDeadline, Date.now() + MIN_ALARM_GAP_MS);
          }
          await this.state.storage.put("current_interval_ms", effectiveMs);
          await this.state.storage.setAlarm(at);
        } catch (alarmErr) {
          console.error("MeetingPoller failed to reschedule alarm", alarmErr);
        }
      }
    }
  }

  /**
   * Request accounting (per HKT day), daily-budget throttle and source-block
   * backoff. Returns the effective interval for the next tick.
   */
  private async applyLiveControls(args: {
    nowMs: number;
    liveMs: number;
    scheduleMs: number;
    gqlAttempts: number;
    fetchOutcome: FetchOutcome;
    horizonEndMs: number | null;
    meetingKey: { meeting_date: string; venue: string };
    captured_at: string;
    sample_interval_s: number;
  }): Promise<number> {
    const { nowMs } = args;
    const day = hkDay(nowMs);
    let usage = await this.state.storage.get<UsageState>("gql_usage");
    if (!usage || usage.day !== day) {
      if (usage && usage.pending > 0) {
        try {
          await addGraphqlUsage(this.env.DB, usage.day, usage.pending);
        } catch (e) {
          console.error("graphql_usage flush (rollover) failed", e);
        }
      }
      usage = { day, pending: 0, global: 0, flushed_at_ms: 0 };
    }
    usage.pending += args.gqlAttempts;
    if (usage.pending > 0 && nowMs - usage.flushed_at_ms >= USAGE_FLUSH_MS) {
      try {
        usage.global = await addGraphqlUsage(this.env.DB, day, usage.pending);
        usage.pending = 0;
        usage.flushed_at_ms = nowMs;
      } catch (e) {
        console.error("graphql_usage flush failed", e);
      }
    }
    await this.state.storage.put("gql_usage", usage);
    const usedToday = usage.global + usage.pending;

    const throttleMs = throttleIntervalMs({
      baseMs: args.liveMs,
      usedToday,
      budget: resolveDailyRequestBudget(this.env),
      nowMs,
      horizonEndMs: args.horizonEndMs,
    });

    const prevBlock =
      (await this.state.storage.get<BlockState>("block_state")) ?? { ...HEALTHY_BLOCK_STATE };
    const t = nextBlockState(prevBlock, args.fetchOutcome, new Date(nowMs).toISOString());
    await this.state.storage.put("block_state", t.state);
    const backoffMs = backoffIntervalMs(args.liveMs, t.state);
    if (t.becameBlocked || t.recovered) {
      await setMeta(this.env.DB, "source_block_state", JSON.stringify(t.state));
      await runStage(this.env, "pushes", async () => {
        await emitPush(this.env, {
          event: t.becameBlocked ? "source_blocked" : "source_recovered",
          meeting_date: args.meetingKey.meeting_date,
          venue: args.meetingKey.venue,
          races: [],
          captured_at: args.captured_at,
          sample_interval_s: args.sample_interval_s,
          meta: {
            reason: t.becameBlocked ? t.state.reason : prevBlock.reason,
            since: t.becameBlocked ? t.state.since : prevBlock.since,
            backoff_ms: backoffMs,
          },
        });
      });
    }
    return effectiveIntervalMs({ scheduleMs: args.scheduleMs, throttleMs, backoffMs });
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
