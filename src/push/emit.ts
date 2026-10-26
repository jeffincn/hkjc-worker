import type { Env } from "../env";
import {
  buildEnvelope,
  type BuildEnvelopeArgs,
  type PushEnvelope,
  type PushEvent,
} from "./envelope";
import { requireEventId } from "./event-id";
import { insertPushEvent } from "./ledger";
import { allocatePushSeq, markLastChange } from "./seq";
import { sendPush, type PushResult } from "./pusher";

/** Events that update last_change_seq / last_change_at for no_update consumers. */
const CHANGE_EVENTS = new Set<PushEvent>([
  "odds_update",
  "odds_delta",
  "lock",
  "scratch",
  "result",
  "dividends",
  "changes",
  "sectionals",
]);

/**
 * Allocate seq + event_id, persist to push_events ledger, return envelope.
 * Does not deliver.
 */
export async function preparePushEvent(
  env: Env,
  args: BuildEnvelopeArgs,
): Promise<PushEnvelope> {
  const seq =
    args.seq ??
    (await allocatePushSeq(env, args.meeting_date, args.venue));
  const envelope = buildEnvelope({
    ...args,
    event_id: args.event_id ?? crypto.randomUUID(),
    seq,
  });
  // Invariant: ledger + downstream queues always see a non-empty event_id.
  requireEventId(envelope);
  await insertPushEvent(env, envelope);
  if (CHANGE_EVENTS.has(envelope.event)) {
    await markLastChange(
      env,
      envelope.meeting_date,
      envelope.venue,
      envelope.seq,
      envelope.captured_at,
    );
  }
  return envelope;
}

/** Prepare ledger row then fan-out to subscribers. */
export async function emitPush(
  env: Env,
  args: BuildEnvelopeArgs,
  opts?: { fetchImpl?: typeof fetch; force?: boolean },
): Promise<{ envelope: PushEnvelope; result: PushResult }> {
  const envelope = await preparePushEvent(env, args);
  const result = await sendPush(env, envelope, opts);
  return { envelope, result };
}
