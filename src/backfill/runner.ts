import type { Env } from "../env";
import { envNum, envStr } from "../env";
import { fetchGraphQL } from "../graphql/client";
import { QUERY_RBC_LIST, QUERY_RBC_MEETING } from "../graphql/queries";
import type { RbcListData, RbcMeetingData } from "../graphql/types";
import { filterLocalMeetings, groupDividends, normalizeBackfillMeeting } from "../parse/meeting";
import { buildEnvelope } from "../push/envelope";
import { sendPush } from "../push/pusher";
import {
  isBackfillDone,
  markBackfillDone,
  persistMeetingTree,
  setMeta,
  storeDividendsAsResults,
} from "../store/db";

export interface BackfillStepResult {
  source: string;
  processed: Array<{ date: string; venue: string; status: string }>;
  remaining_estimate: number;
  done: boolean;
}

/**
 * Resumable GraphQL backfill using rbcList (index) + rbcMeeting (by date).
 * Window ~ BACKFILL_DAYS (default 60). Missing fields stay null.
 */
export async function runBackfillStep(
  env: Env,
  opts?: { limit?: number; fetchImpl?: typeof fetch },
): Promise<BackfillStepResult> {
  const source = envStr(env, "BACKFILL_SOURCE", "graphql");
  if (source === "off" || source === "disabled" || source === "none") {
    return { source, processed: [], remaining_estimate: 0, done: true };
  }
  if (source !== "graphql") {
    return {
      source,
      processed: [{ date: "", venue: "", status: `unsupported BACKFILL_SOURCE=${source}` }],
      remaining_estimate: 0,
      done: true,
    };
  }

  const days = envNum(env, "BACKFILL_DAYS", 60);
  const limit = opts?.limit ?? 5;

  const end = hkDateOffset(0);
  const start = hkDateOffset(-(days - 1));

  const listRes = await fetchGraphQL<RbcListData>({
    query: QUERY_RBC_LIST,
    variables: { startDate: start, endDate: end },
    fetchImpl: opts?.fetchImpl,
  });

  // Server ignores dates and returns a fixed ~2-month window; filter ST/HV and our window.
  const meetings = filterLocalMeetings(listRes.data?.raceMeetings ?? []).filter(
    (m) => m.date >= start && m.date <= end,
  );

  const pending: Array<{ date: string; venue: string }> = [];
  for (const m of meetings) {
    if (!(await isBackfillDone(env.DB, m.date, m.venueCode))) {
      pending.push({ date: m.date, venue: m.venueCode });
    }
  }

  const processed: BackfillStepResult["processed"] = [];
  const batch = pending.slice(0, limit);

  for (const item of batch) {
    try {
      await politeDelay(400);
      const meetingRes = await fetchGraphQL<RbcMeetingData>({
        query: QUERY_RBC_MEETING,
        variables: { date: item.date, venueCode: item.venue },
        fetchImpl: opts?.fetchImpl,
        retries: 3,
      });
      const raw = meetingRes.data?.raceMeetings?.[0];
      if (!raw) {
        await markBackfillDone(env.DB, item.date, item.venue, "graphql_rbc_empty");
        processed.push({ date: item.date, venue: item.venue, status: "empty" });
        continue;
      }

      const normalized = normalizeBackfillMeeting(raw);
      await persistMeetingTree(env.DB, normalized, raw);

      const divMap = groupDividends(raw.pmPools ?? []);
      for (const [raceNo, pools] of divMap) {
        await storeDividendsAsResults(
          env.DB,
          item.date,
          item.venue,
          raceNo,
          pools,
          "graphql_rbc",
        );
      }

      await markBackfillDone(env.DB, item.date, item.venue, "graphql_rbc");
      processed.push({ date: item.date, venue: item.venue, status: "done" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await env.DB.prepare(
        `INSERT INTO backfill_progress (meeting_date, venue, status, data_source, completed_at, error_message)
         VALUES (?, ?, 'error', 'graphql_rbc', NULL, ?)
         ON CONFLICT(meeting_date, venue) DO UPDATE SET status='error', error_message=excluded.error_message`,
      )
        .bind(item.date, item.venue, msg)
        .run();
      processed.push({ date: item.date, venue: item.venue, status: `error:${msg}` });
    }
  }

  const remaining = pending.length - batch.length;
  await setMeta(env.DB, "backfill_last_step_at", new Date().toISOString());

  if (processed.length > 0) {
    await sendPush(
      env,
      buildEnvelope({
        event: "backfill_progress",
        meta: {
          processed,
          remaining_estimate: Math.max(0, remaining),
          window: { start, end, backfill_days: days },
        },
      }),
      { force: true },
    );
  }

  return {
    source,
    processed,
    remaining_estimate: Math.max(0, remaining),
    done: remaining <= 0 && batch.length === 0,
  };
}

/** Calendar date in Asia/Hong_Kong, offset by whole days from today. */
export function hkDateOffset(dayOffset: number): string {
  const d = new Date(Date.now() + dayOffset * 86_400_000);
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "01";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function politeDelay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
