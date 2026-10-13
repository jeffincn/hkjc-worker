/**
 * Per-subscriber quiet hours (Asia/Hong_Kong HH:MM).
 *
 * During quiet hours nothing is sent/queued (incl. heartbeats), except when
 * the envelope's meeting is still in progress (final dividends not published).
 * After quiet ends, one full odds_update is sent if content changed since last push.
 */
import type { Env } from "../env";
import { getMeta, raceHasPublishedDividends, setMeta } from "../store/db";
import {
  lastPushedFromRaces,
  loadLastOddsUpdateHash,
  oddsUpdateRacesHash,
  saveLastOddsUpdateHash,
  saveLastPushedOdds,
} from "./dedupe";
import {
  attemptDelivery,
  type ResolvedTarget,
  type SubscriberDelivery,
} from "./delivery";
import { buildEnvelope, formatHkNow } from "./envelope";
import { requireEventId } from "./event-id";
import { insertPushEvent } from "./ledger";
import { finalRaceNo } from "./odds-policy";
import { allocatePushSeq, markLastChange } from "./seq";
import { buildCompleteSnapshotRaces } from "./snapshot-coverage";
import {
  DEFAULT_QUIET_END,
  DEFAULT_QUIET_START,
  parseQuietHhMm,
  type PushSubscriber,
} from "./subscribers";

export { DEFAULT_QUIET_END, DEFAULT_QUIET_START, parseQuietHhMm };

const HK_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface QuietMeetingContext {
  meeting_date: string;
  venue: string;
  finalDividendsPublished: boolean;
  expectedRaceNos: number[];
}

async function loadQuietMeetingContext(
  db: D1Database,
  meetingDate: string,
  venue: string,
): Promise<QuietMeetingContext> {
  const { results } = await db
    .prepare(
      `SELECT race_no FROM races WHERE meeting_date=? AND venue=? ORDER BY race_no ASC`,
    )
    .bind(meetingDate, venue)
    .all<{ race_no: number }>();
  const expectedRaceNos = (results ?? []).map((r) => r.race_no);
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
    finalDividendsPublished,
    expectedRaceNos,
  };
}

export function hhMmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Minutes since Hong Kong local midnight (0–1439). */
export function hkMinutesOfDay(nowMs: number): number {
  const local = nowMs + HK_OFFSET_MS;
  const iso = new Date(local).toISOString(); // fake-UTC carrying HK wall clock
  const h = Number(iso.slice(11, 13));
  const m = Number(iso.slice(14, 16));
  return h * 60 + m;
}

/**
 * True when now falls in [start, end) on the HK clock.
 * Overnight (start > end): quiet if >= start OR < end (e.g. 23:00–08:00).
 * Same-day (start < end): quiet if >= start AND < end (e.g. 00:00–08:00).
 * Both null → never quiet. One null → never quiet (incomplete config).
 */
export function isInQuietHours(
  nowMs: number,
  quietStart: string | null | undefined,
  quietEnd: string | null | undefined,
): boolean {
  if (!quietStart || !quietEnd) return false;
  const start = hhMmToMinutes(quietStart);
  const end = hhMmToMinutes(quietEnd);
  const now = hkMinutesOfDay(nowMs);
  if (start === end) return false; // degenerate → treat as disabled
  if (start < end) {
    return now >= start && now < end;
  }
  // Overnight wrap
  return now >= start || now < end;
}

function wasQuietMetaKey(subscriberId: number): string {
  return `sub_was_quiet_${subscriberId}`;
}

export async function markSubscriberWasQuiet(
  env: Env,
  subscriberId: number,
): Promise<void> {
  await setMeta(env.DB, wasQuietMetaKey(subscriberId), "1");
}

export async function clearSubscriberWasQuiet(
  env: Env,
  subscriberId: number,
): Promise<void> {
  await setMeta(env.DB, wasQuietMetaKey(subscriberId), "");
}

export async function subscriberWasQuiet(
  db: D1Database,
  subscriberId: number,
): Promise<boolean> {
  const v = await getMeta(db, wasQuietMetaKey(subscriberId));
  return v === "1";
}

/**
 * Quiet-hours gate for one envelope.
 * - Outside quiet → allow (caller may send post-quiet snapshot).
 * - Inside quiet + meeting still in progress → allow (exception).
 * - Inside quiet otherwise → deny.
 */
export async function gateQuietHours(args: {
  env: Env;
  sub: Pick<PushSubscriber, "id" | "quiet_start" | "quiet_end"> | null;
  envelope: { meeting_date?: string | null; venue?: string | null };
  nowMs?: number;
  /** Preloaded meeting context when available. */
  context?: { finalDividendsPublished: boolean; expectedRaceNos: number[] };
}): Promise<{
  allowed: boolean;
  in_quiet: boolean;
  reason?: string;
  /** Meeting still racing through quiet (dividends not published). */
  in_progress_exception?: boolean;
}> {
  const nowMs = args.nowMs ?? Date.now();
  const sub = args.sub;
  if (!sub) {
    return { allowed: true, in_quiet: false };
  }
  const inQuiet = isInQuietHours(nowMs, sub.quiet_start, sub.quiet_end);
  if (!inQuiet) {
    return { allowed: true, in_quiet: false };
  }

  const meetingDate = args.envelope.meeting_date;
  const venue = args.envelope.venue;
  if (meetingDate && venue) {
    const ctx =
      args.context ??
      (await loadQuietMeetingContext(args.env.DB, meetingDate, venue));
    if (!ctx.finalDividendsPublished && ctx.expectedRaceNos.length > 0) {
      // In-progress meeting exception (e.g. HV night finishing after midnight).
      return {
        allowed: true,
        in_quiet: true,
        in_progress_exception: true,
      };
    }
    return {
      allowed: false,
      in_quiet: true,
      reason: "subscriber quiet hours",
    };
  }

  return {
    allowed: false,
    in_quiet: true,
    reason: "subscriber quiet hours",
  };
}

/**
 * After quiet hours end: if we skipped during quiet and meeting odds content
 * changed since last pushed hash, deliver one full odds_update to this sub.
 */
export async function maybeDeliverPostQuietSnapshot(args: {
  env: Env;
  subscriber: PushSubscriber;
  target: ResolvedTarget;
  meeting_date: string;
  venue: string;
  expectedRaceNos?: number[];
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<SubscriberDelivery | null> {
  const { env, subscriber, target } = args;
  if (!(await subscriberWasQuiet(env.DB, subscriber.id))) return null;

  const expectedRaceNos =
    args.expectedRaceNos ??
    (await loadQuietMeetingContext(env.DB, args.meeting_date, args.venue))
      .expectedRaceNos;
  if (expectedRaceNos.length === 0) {
    await clearSubscriberWasQuiet(env, subscriber.id);
    return null;
  }

  const { races, meta: coverage } = await buildCompleteSnapshotRaces({
    env,
    meeting_date: args.meeting_date,
    venue: args.venue,
    expectedRaceNos,
    available: [],
  });

  // Always clear the flag so we don't loop; only send when content changed.
  await clearSubscriberWasQuiet(env, subscriber.id);

  if (races.length === 0) return null;

  const hash = await oddsUpdateRacesHash(races);
  const last = await loadLastOddsUpdateHash(
    env.DB,
    args.meeting_date,
    args.venue,
  );
  if (last != null && last === hash) {
    return null; // content unchanged since last push
  }

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
      post_quiet_snapshot: true,
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
    await saveLastOddsUpdateHash(env, args.meeting_date, args.venue, hash);
    await saveLastPushedOdds(
      env,
      args.meeting_date,
      args.venue,
      lastPushedFromRaces(races),
    );
  }
  return delivery;
}
