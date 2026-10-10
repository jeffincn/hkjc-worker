import type { Env } from "../env";
import { envNum } from "../env";
import { fetchGraphQL } from "../graphql/client";
import { QUERY_PM_POOLS_ODDS, QUERY_RACE_MEETINGS_FULL } from "../graphql/queries";
import type { PmPoolsOddsData, RaceMeetingsFullData } from "../graphql/types";
import { normalizeMeeting, resultsComplete } from "../parse/meeting";
import { buildRaceOddsSnapshot, poolsByRace } from "../parse/odds";
import { buildEnvelope, type PushRace } from "../push/envelope";
import { sendPush } from "../push/pusher";
import {
  insertOddsSnapshotIfChanged,
  meetingTreeContentHash,
  persistMeetingTree,
  setMeta,
} from "../store/db";
import { computePollIntervalMs, selectRelevantPostTime } from "./interval";

interface DoState {
  meeting_date: string;
  venue: string;
  locked_races: number[];
  result_races: number[];
}

const LAST_FETCH_D1_FLUSH_MS = 5 * 60 * 1000;

/**
 * One Durable Object per meeting. Alarm self-loop:
 * 60 min when >24h before post, 5 min when 2–24h, 60s when 30min–2h,
 * 30s inside 30min.
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
      return new Response(JSON.stringify({ cfg, alarm, last_fetch_at: lastFetchAt ?? null }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const cfg = await this.state.storage.get<DoState>("cfg");
    if (!cfg) return;

    const fastSec = envNum(this.env, "POLL_INTERVAL_SEC", 30);

    try {
      const full = await fetchGraphQL<RaceMeetingsFullData>({
        query: QUERY_RACE_MEETINGS_FULL,
        variables: { date: cfg.meeting_date, venueCode: cfg.venue },
      });
      const raw =
        (full.data?.raceMeetings ?? []).find(
          (m) => m.date === cfg.meeting_date && m.venueCode === cfg.venue,
        ) ?? full.data?.raceMeetings?.[0];

      if (!raw) {
        await this.state.storage.setAlarm(Date.now() + 60_000);
        return;
      }

      // If GraphQL returned a different (current) meeting, update cfg
      if (raw.date !== cfg.meeting_date || raw.venueCode !== cfg.venue) {
        cfg.meeting_date = raw.date;
        cfg.venue = raw.venueCode;
        await this.state.storage.put("cfg", cfg);
      }

      const meeting = normalizeMeeting(raw, "graphql");
      const treeHash = await meetingTreeContentHash(meeting);
      const prevHash = await this.state.storage.get<string>("meeting_tree_hash");
      if (treeHash !== prevHash) {
        await persistMeetingTree(this.env.DB, meeting, raw);
        await this.state.storage.put("meeting_tree_hash", treeHash);
      }

      await this.touchLastFetchAt();

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

      const changed: PushRace[] = [];
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
        const ins = await insertOddsSnapshotIfChanged(
          this.env.DB,
          meeting.meeting_date,
          meeting.venue,
          snap,
        );
        const pushRace: PushRace = {
          race_no: snap.race_no,
          post_time: snap.post_time,
          snapshot_time: snap.snapshot_time,
          pool_status: snap.pool_status,
          runners: snap.runners,
        };

        if (ins.inserted) changed.push(pushRace);

        if (snap.pool_status === "STOP_SELL" && !cfg.locked_races.includes(race.race_no)) {
          cfg.locked_races.push(race.race_no);
          await sendPush(
            this.env,
            buildEnvelope({
              event: "lock",
              meeting_date: meeting.meeting_date,
              venue: meeting.venue,
              races: [pushRace],
            }),
          );
        }

        if (resultsComplete(race) && !cfg.result_races.includes(race.race_no)) {
          cfg.result_races.push(race.race_no);
          await sendPush(
            this.env,
            buildEnvelope({
              event: "result",
              meeting_date: meeting.meeting_date,
              venue: meeting.venue,
              races: [pushRace],
            }),
          );
        }
      }

      if (changed.length > 0) {
        await sendPush(
          this.env,
          buildEnvelope({
            event: "odds_update",
            meeting_date: meeting.meeting_date,
            venue: meeting.venue,
            races: changed,
          }),
        );
      }

      await this.state.storage.put("cfg", cfg);

      const allDone =
        meeting.status === "CLOSED" ||
        meeting.races.every((r) => cfg.result_races.includes(r.race_no));

      if (allDone) {
        // Stop high-frequency polling; cron will re-check daily
        return;
      }

      const post = selectRelevantPostTime(
        meeting.races.map((r) => ({ post_time: r.post_time, status: r.status })),
        Date.now(),
      );
      const interval = computePollIntervalMs({
        nowMs: Date.now(),
        postTimeIso: post,
        fastIntervalSec: fastSec,
        slowIntervalSec: 60,
        idleIntervalSec: 300,
      });
      await this.state.storage.setAlarm(Date.now() + interval);
    } catch (err) {
      // retry slowly on errors
      console.error("MeetingPoller alarm error", err);
      await this.state.storage.setAlarm(Date.now() + 60_000);
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
