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
 */
export async function allocatePushSeq(
  env: Env,
  meeting_date: string | null | undefined,
  venue: string | null | undefined,
): Promise<number> {
  const key = seqKey(meeting_date, venue);
  // D1 has no true UPSERT-RETURNING race-free counter across workers, but
  // MeetingPoller is single-threaded per meeting DO and cron is coarse.
  // Use read-modify-write within a batch where possible.
  const existing = await env.DB.prepare(
    `SELECT next_seq FROM push_seq WHERE meeting_date = ? AND venue = ?`,
  )
    .bind(key.meeting_date, key.venue)
    .first<{ next_seq: number }>();

  const next = (existing?.next_seq ?? 0) + 1;
  if (existing == null) {
    await env.DB.prepare(
      `INSERT INTO push_seq (meeting_date, venue, next_seq) VALUES (?, ?, ?)`,
    )
      .bind(key.meeting_date, key.venue, next)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE push_seq SET next_seq = ? WHERE meeting_date = ? AND venue = ?`,
    )
      .bind(next, key.meeting_date, key.venue)
      .run();
  }
  return next;
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
