/**
 * Per-subscriber active delivery window.
 *
 * - always: every event is eligible
 * - raceday: only while now ∈ [first_post − window_before_sec, final dividends)
 *   Outside that window nothing is sent or queued (incl. heartbeats).
 *   On first in-window delivery for a meeting, a full odds_update snapshot
 *   is sent to that subscriber before the triggering event.
 */
import type { Env } from "../env";
import { getMeta, setMeta, raceHasPublishedDividends } from "../store/db";
import {
  attemptDelivery,
  type ResolvedTarget,
  type SubscriberDelivery,
} from "./delivery";
import type { PushEnvelope } from "./envelope";
import { buildEnvelope, formatHkNow } from "./envelope";
import { requireEventId } from "./event-id";
import { insertPushEvent } from "./ledger";
import { finalRaceNo, isInRaceDayHighFreqWindow } from "./odds-policy";
import { allocatePushSeq, markLastChange } from "./seq";
import { buildCompleteSnapshotRaces } from "./snapshot-coverage";
import {
  gateQuietHours,
  markSubscriberWasQuiet,
} from "./quiet-hours";
import {
  DEFAULT_SUBSCRIBER_WINDOW_BEFORE_SEC,
  type PushSubscriber,
} from "./subscribers";

export {
  DEFAULT_SUBSCRIBER_WINDOW_BEFORE_SEC,
  parseActiveWindow,
  parseWindowBeforeSec,
  type ActiveWindowMode,
} from "./subscribers";

export interface MeetingWindowContext {
  meeting_date: string;
  venue: string;
  firstPostMs: number | null;
  finalDividendsPublished: boolean;
  expectedRaceNos: number[];
}

/** Load first post / final-dividends / race card for a meeting from D1. */
export async function loadMeetingWindowContext(
  db: D1Database,
  meetingDate: string,
  venue: string,
): Promise<MeetingWindowContext> {
  const { results } = await db
    .prepare(
      `SELECT race_no, post_time FROM races
       WHERE meeting_date=? AND venue=?
       ORDER BY race_no ASC`,
    )
    .bind(meetingDate, venue)
    .all<{ race_no: number; post_time: string | null }>();

  const races = results ?? [];
  const expectedRaceNos = races.map((r) => r.race_no);
  let firstPostMs: number | null = null;
  for (const r of races) {
    if (!r.post_time) continue;
    const ms = Date.parse(r.post_time);
    if (!Number.isFinite(ms)) continue;
    if (firstPostMs == null || ms < firstPostMs) firstPostMs = ms;
  }

  const lastNo = finalRaceNo(expectedRaceNos.map((n) => ({ race_no: n })));
  let finalDividendsPublished = false;
  if (lastNo != null) {
    finalDividendsPublished = await raceHasPublishedDividends(
      db,
      meetingDate,
      venue,
      lastNo,
    );
  }

  return {
    meeting_date: meetingDate,
    venue,
    firstPostMs,
    finalDividendsPublished,
    expectedRaceNos,
  };
}

export function isInSubscriberRaceDayWindow(args: {
  nowMs: number;
  firstPostMs: number | null;
  finalDividendsPublished: boolean;
  windowBeforeSec: number;
}): boolean {
  return isInRaceDayHighFreqWindow({
    nowMs: args.nowMs,
    firstPostMs: args.firstPostMs,
    finalDividendsPublished: args.finalDividendsPublished,
    windowBeforeSec: args.windowBeforeSec,
  });
}

export interface WindowGateResult {
  allowed: boolean;
  /** True when mode is raceday and now is inside the meeting window. */
  in_window: boolean;
  /** True when HK clock is inside subscriber quiet hours. */
  in_quiet?: boolean;
  /** Allowed only because meeting still in progress through quiet hours. */
  in_progress_exception?: boolean;
  reason?: string;
  context?: MeetingWindowContext;
}

/**
 * Decide whether this subscriber may receive / be queued for `envelope`.
 * Fallback target (no subscriber row) is treated as `always` + no quiet hours.
 *
 * Order: raceday active_window → quiet hours (with in-progress exception).
 */
export async function gateSubscriberDelivery(
  env: Env,
  sub: Pick<
    PushSubscriber,
    "id" | "active_window" | "window_before_sec" | "quiet_start" | "quiet_end"
  > | null,
  envelope: Pick<PushEnvelope, "meeting_date" | "venue" | "event">,
  nowMs: number = Date.now(),
): Promise<WindowGateResult> {
  const mode = sub?.active_window ?? "always";
  let context: MeetingWindowContext | undefined;
  let in_window = true;

  if (mode === "raceday") {
    const meetingDate = envelope.meeting_date;
    const venue = envelope.venue;
    if (!meetingDate || !venue) {
      return {
        allowed: false,
        in_window: false,
        reason: "raceday subscriber requires meeting_date+venue",
      };
    }

    context = await loadMeetingWindowContext(env.DB, meetingDate, venue);
    const before = sub?.window_before_sec ?? DEFAULT_SUBSCRIBER_WINDOW_BEFORE_SEC;
    in_window = isInSubscriberRaceDayWindow({
      nowMs,
      firstPostMs: context.firstPostMs,
      finalDividendsPublished: context.finalDividendsPublished,
      windowBeforeSec: before,
    });
    if (!in_window) {
      return {
        allowed: false,
        in_window: false,
        reason: "outside subscriber raceday window",
        context,
      };
    }
  }

  // Quiet hours (00:00–08:00 HKT by default). In-progress meetings exempt.
  const quiet = await gateQuietHours({
    env,
    sub,
    envelope,
    nowMs,
    context,
  });
  if (!quiet.allowed) {
    if (sub?.id != null) {
      await markSubscriberWasQuiet(env, sub.id);
    }
    return {
      allowed: false,
      in_window,
      in_quiet: true,
      reason: quiet.reason ?? "subscriber quiet hours",
      context,
    };
  }

  return {
    allowed: true,
    in_window,
    in_quiet: quiet.in_quiet,
    in_progress_exception: quiet.in_progress_exception,
    context,
  };
}

function windowSnapMetaKey(
  subscriberId: number,
  meetingDate: string,
  venue: string,
): string {
  return `sub_window_snap_${subscriberId}_${meetingDate}_${venue}`;
}

export async function hasSentWindowOpenSnapshot(
  db: D1Database,
  subscriberId: number,
  meetingDate: string,
  venue: string,
): Promise<boolean> {
  const v = await getMeta(db, windowSnapMetaKey(subscriberId, meetingDate, venue));
  return v != null && v.length > 0;
}

export async function markWindowOpenSnapshotSent(
  env: Env,
  subscriberId: number,
  meetingDate: string,
  venue: string,
): Promise<void> {
  await setMeta(
    env.DB,
    windowSnapMetaKey(subscriberId, meetingDate, venue),
    new Date().toISOString(),
  );
}

/**
 * If this raceday subscriber has not yet received the window-open full
 * snapshot for the meeting, build + deliver one odds_update to them only.
 * Returns the delivery outcome (or null when not needed / not applicable).
 */
export async function maybeDeliverWindowOpenSnapshot(args: {
  env: Env;
  subscriber: PushSubscriber;
  target: ResolvedTarget;
  meeting_date: string;
  venue: string;
  context?: MeetingWindowContext;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<SubscriberDelivery | null> {
  const { env, subscriber, target } = args;
  if (subscriber.active_window !== "raceday") return null;
  if (subscriber.id == null) return null;

  const already = await hasSentWindowOpenSnapshot(
    env.DB,
    subscriber.id,
    args.meeting_date,
    args.venue,
  );
  if (already) return null;

  const ctx =
    args.context ??
    (await loadMeetingWindowContext(env.DB, args.meeting_date, args.venue));
  if (ctx.expectedRaceNos.length === 0) {
    // No card yet — don't mark sent; retry on a later event.
    return null;
  }

  const { races, meta: coverage } = await buildCompleteSnapshotRaces({
    env,
    meeting_date: args.meeting_date,
    venue: args.venue,
    expectedRaceNos: ctx.expectedRaceNos,
    available: [],
  });
  if (races.length === 0) {
    return null;
  }

  // Prepare ledger row without fan-out (avoid circular import via emit/pusher).
  const seq = await allocatePushSeq(env, args.meeting_date, args.venue);
  const envelope = buildEnvelope({
    event: "odds_update",
    meeting_date: args.meeting_date,
    venue: args.venue,
    races,
    captured_at: formatHkNow(new Date(args.nowMs ?? Date.now())),
    sample_interval_s: null,
    source_last_updated_at: null,
    event_id: crypto.randomUUID(),
    seq,
    meta: {
      window_open_snapshot: true,
      subscriber_id: subscriber.id,
      ...coverage,
    },
  });
  requireEventId(envelope);
  await insertPushEvent(env, envelope);
  await markLastChange(
    env,
    args.meeting_date,
    args.venue,
    envelope.seq,
    envelope.captured_at,
  );

  const delivery = await attemptDelivery(
    env,
    envelope,
    target,
    args.fetchImpl ?? fetch,
  );
  if (delivery.success || delivery.skipped_dedupe) {
    await markWindowOpenSnapshotSent(
      env,
      subscriber.id,
      args.meeting_date,
      args.venue,
    );
  }
  return delivery;
}
