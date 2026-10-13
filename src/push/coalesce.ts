import type { Env } from "../env";
import { envNum } from "../env";
import {
  buildEnvelope,
  type OddsDeltaChange,
  type OddsPoolInvestment,
  type PushEnvelope,
  type PushEvent,
} from "./envelope";
import { preparePushEvent } from "./emit";
import { getPushEventById } from "./ledger";
import { GAVE_UP } from "./pending";

/** Min active pending rows per subscriber before coalescing (default 2). */
export const DEFAULT_BACKLOG_COALESCE_MIN = 2;
/** Max odds change rows per backlog_replay chunk (default 200). */
export const DEFAULT_BACKLOG_MAX_CHANGES = 200;

export function backlogCoalesceMin(env: Env): number {
  return Math.max(1, envNum(env, "PUSH_BACKLOG_COALESCE_MIN", DEFAULT_BACKLOG_COALESCE_MIN));
}

export function backlogMaxChanges(env: Env): number {
  return Math.max(1, envNum(env, "PUSH_BACKLOG_MAX_CHANGES", DEFAULT_BACKLOG_MAX_CHANGES));
}

/** Odds change annotated with the originating event's identity/time. */
export interface BacklogOddsChange extends OddsDeltaChange {
  /** Original event seq that produced this change. */
  seq: number;
  /** Original event captured_at. */
  captured_at: string;
  /** Original event_id when known. */
  source_event_id?: string;
}

export interface PendingPushRow {
  id: number;
  event_type: string;
  payload_json: string;
  retry_count: number;
  subscriber_id: number | null;
  event_id: string | null;
  last_error: string | null;
  next_retry_at?: string | null;
  created_at?: string | null;
}

export interface CoalescedDelivery {
  envelope: PushEnvelope;
  /** Pending row ids consumed into this delivery. */
  source_row_ids: number[];
  /** Max retry_count among sources (for re-enqueue on failure). */
  retry_count: number;
}

function meetingKey(meeting_date: string | null, venue: string | null): string {
  return `${meeting_date ?? "*"}|${venue ?? "*"}`;
}

async function resolveEnvelope(
  env: Env,
  row: PendingPushRow,
): Promise<PushEnvelope> {
  if (row.event_id) {
    const fromLedger = await getPushEventById(env, row.event_id);
    if (fromLedger) return fromLedger;
  }
  return JSON.parse(row.payload_json) as PushEnvelope;
}

function annotateChanges(
  envelope: PushEnvelope,
): BacklogOddsChange[] {
  const changes = envelope.changes ?? [];
  return changes.map((c) => ({
    ...c,
    seq: envelope.seq,
    captured_at: envelope.captured_at,
    source_event_id: envelope.event_id || undefined,
  }));
}

function mergePools(
  poolsList: OddsPoolInvestment[][],
): OddsPoolInvestment[] {
  const map = new Map<string, OddsPoolInvestment>();
  for (const pools of poolsList) {
    for (const p of pools) {
      map.set(`${p.race_no}:${p.bet_type}`, p);
    }
  }
  return [...map.values()].sort(
    (a, b) => a.race_no - b.race_no || a.bet_type.localeCompare(b.bet_type),
  );
}

/**
 * Coalesce a subscriber's pending rows for one meeting:
 * - odds_delta: concatenate every change in seq order (annotated with seq/captured_at)
 * - other event types: keep only the latest (highest seq, then id)
 * Returns one or more size-bounded backlog_replay envelopes for odds, plus
 * latest envelopes for non-odds types (unchanged event type).
 */
export function planMeetingCoalesce(
  rows: Array<{ row: PendingPushRow; envelope: PushEnvelope }>,
  maxChanges: number,
): {
  oddsChunks: Array<{
    changes: BacklogOddsChange[];
    pools: OddsPoolInvestment[];
    source_row_ids: number[];
    event_ids: string[];
    seq_from: number;
    seq_to: number;
    retry_count: number;
    meeting_date: string | null;
    venue: string | null;
    source_last_updated_at: string | null;
  }>;
  latestByType: Array<{
    envelope: PushEnvelope;
    row: PendingPushRow;
  }>;
} {
  const ordered = [...rows].sort((a, b) => {
    const seq = (a.envelope.seq ?? 0) - (b.envelope.seq ?? 0);
    if (seq !== 0) return seq;
    return a.row.id - b.row.id;
  });

  const oddsRows = ordered.filter((r) => r.envelope.event === "odds_delta");
  const nonOdds = ordered.filter((r) => r.envelope.event !== "odds_delta");

  // Collapse non-odds of the same type to the latest.
  const latestMap = new Map<PushEvent, { envelope: PushEnvelope; row: PendingPushRow }>();
  for (const item of nonOdds) {
    latestMap.set(item.envelope.event, item);
  }

  const allChanges: BacklogOddsChange[] = [];
  const allPools: OddsPoolInvestment[][] = [];
  const oddsRowIds: number[] = [];
  const oddsEventIds: string[] = [];
  let seqFrom = Infinity;
  let seqTo = -Infinity;
  let oddsRetry = 0;
  let meeting_date: string | null = null;
  let venue: string | null = null;
  let source_last_updated_at: string | null = null;

  for (const item of oddsRows) {
    const e = item.envelope;
    meeting_date = e.meeting_date;
    venue = e.venue;
    if (e.source?.last_updated_at) source_last_updated_at = e.source.last_updated_at;
    const seq = e.seq ?? 0;
    seqFrom = Math.min(seqFrom, seq);
    seqTo = Math.max(seqTo, seq);
    oddsRetry = Math.max(oddsRetry, item.row.retry_count ?? 0);
    oddsRowIds.push(item.row.id);
    if (e.event_id) oddsEventIds.push(e.event_id);
    allChanges.push(...annotateChanges(e));
    if (e.pools) allPools.push(e.pools);
  }

  const oddsChunks: ReturnType<typeof planMeetingCoalesce>["oddsChunks"] = [];
  if (allChanges.length > 0) {
    const pools = mergePools(allPools);
    for (let i = 0; i < allChanges.length; i += maxChanges) {
      const slice = allChanges.slice(i, i + maxChanges);
      const sliceSeqs = slice.map((c) => c.seq);
      oddsChunks.push({
        changes: slice,
        pools,
        source_row_ids: oddsRowIds,
        event_ids: oddsEventIds,
        seq_from: sliceSeqs.length ? Math.min(...sliceSeqs) : seqFrom,
        seq_to: sliceSeqs.length ? Math.max(...sliceSeqs) : seqTo,
        retry_count: oddsRetry,
        meeting_date,
        venue,
        source_last_updated_at,
      });
    }
  }

  return {
    oddsChunks,
    latestByType: [...latestMap.values()],
  };
}

/**
 * Build ledgered backlog_replay / latest envelopes from pending rows.
 * Caller deletes source rows and delivers.
 */
export async function buildCoalescedDeliveries(
  env: Env,
  rows: PendingPushRow[],
): Promise<CoalescedDelivery[]> {
  if (rows.length === 0) return [];

  const resolved: Array<{ row: PendingPushRow; envelope: PushEnvelope }> = [];
  for (const row of rows) {
    resolved.push({ row, envelope: await resolveEnvelope(env, row) });
  }

  const byMeeting = new Map<string, typeof resolved>();
  for (const item of resolved) {
    const key = meetingKey(item.envelope.meeting_date, item.envelope.venue);
    const list = byMeeting.get(key) ?? [];
    list.push(item);
    byMeeting.set(key, list);
  }

  const maxChanges = backlogMaxChanges(env);
  const out: CoalescedDelivery[] = [];

  for (const group of byMeeting.values()) {
    const plan = planMeetingCoalesce(group, maxChanges);
    const chunkTotal = plan.oddsChunks.length;

    for (let i = 0; i < plan.oddsChunks.length; i++) {
      const chunk = plan.oddsChunks[i]!;
      const envelope = await preparePushEvent(env, {
        event: "backlog_replay",
        meeting_date: chunk.meeting_date,
        venue: chunk.venue,
        races: [],
        changes: chunk.changes,
        pools: chunk.pools,
        source_last_updated_at: chunk.source_last_updated_at,
        meta: {
          covered_seq_from: chunk.seq_from,
          covered_seq_to: chunk.seq_to,
          coalesced_count: chunk.event_ids.length || chunk.source_row_ids.length,
          coalesced_event_ids: chunk.event_ids,
          chunk_index: i,
          chunk_total: chunkTotal,
          reason: "pending_backlog",
        },
      });
      out.push({
        envelope,
        source_row_ids: chunk.source_row_ids,
        retry_count: chunk.retry_count,
      });
    }

    for (const latest of plan.latestByType) {
      out.push({
        envelope: latest.envelope,
        source_row_ids: [latest.row.id],
        retry_count: latest.row.retry_count ?? 0,
      });
    }
  }

  return out;
}

/** Count active (non-gave_up) pending rows per subscriber. */
export async function countPendingBySubscriber(
  env: Env,
): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT subscriber_id, COUNT(*) AS n FROM pending_pushes
     WHERE IFNULL(last_error, '') != ?
     GROUP BY subscriber_id`,
  )
    .bind(GAVE_UP)
    .all<{ subscriber_id: number | null; n: number }>();

  const map = new Map<string, number>();
  for (const row of results ?? []) {
    const key = row.subscriber_id == null ? "fallback" : String(row.subscriber_id);
    map.set(key, row.n ?? 0);
  }
  return map;
}

export async function getSubscriberBacklogSize(
  env: Env,
  subscriberId: number | null,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM pending_pushes
     WHERE IFNULL(last_error, '') != ?
       AND (
         (? IS NULL AND subscriber_id IS NULL)
         OR subscriber_id = ?
       )`,
  )
    .bind(GAVE_UP, subscriberId, subscriberId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Pure helper: should this subscriber's pending set be coalesced?
 */
export function shouldCoalesceBacklog(
  pendingCount: number,
  coalesceMin: number,
): boolean {
  return pendingCount >= coalesceMin;
}

/** Exported for unit tests that need a synthetic envelope without D1. */
export function buildBacklogReplayEnvelopeArgs(args: {
  meeting_date: string | null;
  venue: string | null;
  changes: BacklogOddsChange[];
  pools?: OddsPoolInvestment[];
  seq_from: number;
  seq_to: number;
  event_ids?: string[];
  chunk_index?: number;
  chunk_total?: number;
}): ReturnType<typeof buildEnvelope> {
  return buildEnvelope({
    event: "backlog_replay",
    meeting_date: args.meeting_date,
    venue: args.venue,
    races: [],
    changes: args.changes,
    pools: args.pools ?? [],
    source_last_updated_at: null,
    seq: args.seq_to,
    meta: {
      covered_seq_from: args.seq_from,
      covered_seq_to: args.seq_to,
      coalesced_count: args.event_ids?.length ?? 0,
      coalesced_event_ids: args.event_ids ?? [],
      chunk_index: args.chunk_index ?? 0,
      chunk_total: args.chunk_total ?? 1,
      reason: "pending_backlog",
    },
  });
}
