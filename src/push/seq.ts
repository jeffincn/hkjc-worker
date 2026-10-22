import type { Env } from "../env";

/** Sentinel key for events without a meeting (schedule, whitelist_alert, …). */
export const GLOBAL_SEQ_MEETING = "*";
export const GLOBAL_SEQ_VENUE = "*";

export function seqKey(
  meeting_date: string | null | undefined,
  venue: string | null | undefined,
): { meeting_date: string; venue: string } {
  if (!meeting_date || !venue) {
    return { meeting_date: GLOBAL_SEQ_MEETING, venue: GLOBAL_SEQ_VENUE };
  }
  return { meeting_date, venue };
}

/**
 * Atomically allocate the next monotonic seq for meeting_date+venue.
 * Increments once per event (not per subscriber).
 *
 * Uses INSERT … ON CONFLICT DO UPDATE … RETURNING so concurrent allocators
 * cannot both read the same next_seq (jeffincn/hkjc-agent-runner#10).
 */
export async function allocatePushSeq(
  env: Env,
  meeting_date: string | null | undefined,
  venue: string | null | undefined,
): Promise<number> {
  const key = seqKey(meeting_date, venue);
  const row = await env.DB.prepare(
    `INSERT INTO push_seq (meeting_date, venue, next_seq)
     VALUES (?, ?, 1)
     ON CONFLICT(meeting_date, venue) DO UPDATE SET
       next_seq = push_seq.next_seq + 1
     RETURNING next_seq`,
  )
    .bind(key.meeting_date, key.venue)
    .first<{ next_seq: number }>();

  if (row == null || !Number.isFinite(row.next_seq)) {
    throw new Error(
      `allocatePushSeq: RETURNING next_seq failed for ${key.meeting_date}/${key.venue}`,
    );
  }
  return row.next_seq;
}

export async function markLastChange(
  env: Env,
  meeting_date: string | null | undefined,
  venue: string | null | undefined,
  seq: number,
  at: string,
): Promise<void> {
  const key = seqKey(meeting_date, venue);
  await env.DB.prepare(
    `INSERT INTO push_seq (meeting_date, venue, next_seq, last_change_seq, last_change_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(meeting_date, venue) DO UPDATE SET
       last_change_seq = excluded.last_change_seq,
       last_change_at = excluded.last_change_at`,
  )
    .bind(key.meeting_date, key.venue, seq, seq, at)
    .run();
}

export async function getLastChange(
  env: Env,
  meeting_date: string | null | undefined,
  venue: string | null | undefined,
): Promise<{ last_change_seq: number | null; last_change_at: string | null }> {
  const key = seqKey(meeting_date, venue);
  const row = await env.DB.prepare(
    `SELECT last_change_seq, last_change_at FROM push_seq
     WHERE meeting_date = ? AND venue = ?`,
  )
    .bind(key.meeting_date, key.venue)
    .first<{ last_change_seq: number | null; last_change_at: string | null }>();
  return {
    last_change_seq: row?.last_change_seq ?? null,
    last_change_at: row?.last_change_at ?? null,
  };
}
