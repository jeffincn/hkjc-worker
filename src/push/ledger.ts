import type { Env } from "../env";
import type { PushEnvelope } from "./envelope";
import { formatHkNow } from "./envelope";

export async function insertPushEvent(
  env: Env,
  envelope: PushEnvelope,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO push_events (
       event_id, seq, meeting_date, venue, event_type,
       captured_at, source_last_updated_at, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      envelope.event_id,
      envelope.seq,
      envelope.meeting_date,
      envelope.venue,
      envelope.event,
      envelope.captured_at ?? null,
      envelope.source?.last_updated_at ?? null,
      JSON.stringify(envelope),
      formatHkNow(),
    )
    .run();
}

export async function getPushEventById(
  env: Env,
  eventId: string,
): Promise<PushEnvelope | null> {
  const row = await env.DB.prepare(
    `SELECT payload_json FROM push_events WHERE event_id = ?`,
  )
    .bind(eventId)
    .first<{ payload_json: string }>();
  if (!row) return null;
  return JSON.parse(row.payload_json) as PushEnvelope;
}

export async function listPushEvents(
  env: Env,
  opts: {
    meeting_date: string;
    venue: string;
    since_seq?: number;
    limit?: number;
  },
): Promise<PushEnvelope[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const since = opts.since_seq ?? 0;
  const { results } = await env.DB.prepare(
    `SELECT payload_json FROM push_events
     WHERE meeting_date = ? AND venue = ? AND seq > ?
     ORDER BY seq ASC LIMIT ?`,
  )
    .bind(opts.meeting_date, opts.venue, since, limit)
    .all<{ payload_json: string }>();

  return (results ?? []).map((r) => JSON.parse(r.payload_json) as PushEnvelope);
}
