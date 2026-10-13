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
 * Per-race incremental events: envelopes carry only the races that changed in
 * that cycle (see MeetingPoller lock/result emits). Collapsing to "latest of
 * type" would drop earlier races — coalesce by (event, race_no) instead.
 */
export const PER_RACE_INCREMENTAL_EVENTS = new Set<PushEvent>([
  "lock",
  "result",
  "scratch",
  "dividends",
]);

/**
 * Meeting-level / full-snapshot events: latest envelope of the type is enough
 * (odds state, schedule, meta-only alerts, horse pages, …).
 */
export const MEETING_SNAPSHOT_EVENTS = new Set<PushEvent>([
  "odds_update",
  "no_update",
  "schedule",
  "changes",
  "horse_update",
  "injury_update",
  "runs_update",
  "test",
  "backfill_progress",
  "whitelist_alert",
  "source_blocked",
  "source_recovered",
  "odds_coverage_gap",
]);

export function raceNosOf(envelope: PushEnvelope): number[] {
  const nos: number[] = [];
  for (const r of envelope.races ?? []) {
    if (typeof r.race_no === "number" && r.race_no > 0) nos.push(r.race_no);
  }
  // dividends may carry race_nos only in meta.race_nos / meta.races
  const meta = envelope.meta;
  if (meta && Array.isArray(meta.race_nos)) {
    for (const n of meta.race_nos) {
      const num = Number(n);
      if (Number.isFinite(num) && num > 0) nos.push(num);
    }
  }
  return [...new Set(nos)].sort((a, b) => a - b);
}

type NonOddsItem = { envelope: PushEnvelope; row: PendingPushRow };

/**
 * Plan non-odds deliveries for one event type:
 * - per-race incremental with identifiable race_nos → keep latest envelope per
 *   race_no (unique envelopes; one envelope covering many races is sent once)
 * - meeting snapshots → keep latest envelope of the type
 * - unsure (unknown type, or per-race type with no race_no) → resend one-by-one
 */
export function planNonOddsDeliveries(
  items: NonOddsItem[],
): NonOddsItem[] {
  if (items.length === 0) return [];
  const event = items[0]!.envelope.event;

  if (PER_RACE_INCREMENTAL_EVENTS.has(event)) {
    const anyMissingRace = items.some((i) => raceNosOf(i.envelope).length === 0);
    if (anyMissingRace) {
      // Unsure which races are covered — do not drop; replay every row.
      return items;
    }
    // Latest wins per race_no; deliver the unique envelopes that cover them.
    const byRace = new Map<number, NonOddsItem>();
    for (const item of items) {
      for (const raceNo of raceNosOf(item.envelope)) {
        byRace.set(raceNo, item);
      }
    }
    const seen = new Set<number>();
    const out: NonOddsItem[] = [];
    // Stable order by first-seen race_no ascending for determinism.
    for (const raceNo of [...byRace.keys()].sort((a, b) => a - b)) {
      const item = byRace.get(raceNo)!;
      if (seen.has(item.row.id)) continue;
      seen.add(item.row.id);
      out.push(item);
    }
    return out;
  }

  if (MEETING_SNAPSHOT_EVENTS.has(event)) {
    return [items[items.length - 1]!];
  }

  // Unknown event type — resend one-by-one.
  return items;
}

/**
 * Coalesce a subscriber's pending rows for one meeting:
 * - odds_delta: concatenate every change in seq order (annotated with seq/captured_at)
 * - per-race incremental (lock/result/scratch/dividends): keep latest per race_no
 * - meeting snapshots: keep latest of type
 * - unsure: resend one-by-one
 * Returns size-bounded backlog_replay chunks for odds, plus non-odds deliveries.
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
  /** @deprecated alias — prefer nonOddsDeliveries */
  latestByType: NonOddsItem[];
  nonOddsDeliveries: NonOddsItem[];
} {
  const ordered = [...rows].sort((a, b) => {
    const seq = (a.envelope.seq ?? 0) - (b.envelope.seq ?? 0);
    if (seq !== 0) return seq;
    return a.row.id - b.row.id;
  });

  const oddsRows = ordered.filter((r) => r.envelope.event === "odds_delta");
  const nonOdds = ordered.filter((r) => r.envelope.event !== "odds_delta");

  // Group non-odds by event type, then apply per-type coalesce rules.
  const byType = new Map<PushEvent, NonOddsItem[]>();
  for (const item of nonOdds) {
    const list = byType.get(item.envelope.event) ?? [];
    list.push(item);
    byType.set(item.envelope.event, list);
  }
  const nonOddsDeliveries: NonOddsItem[] = [];
  for (const group of byType.values()) {
    nonOddsDeliveries.push(...planNonOddsDeliveries(group));
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
    latestByType: nonOddsDeliveries,
    nonOddsDeliveries,
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

    for (const item of plan.nonOddsDeliveries) {
      out.push({
        envelope: item.envelope,
        source_row_ids: [item.row.id],
        retry_count: item.row.retry_count ?? 0,
      });
    }

    // Rows that were coalesced away (superseded per race_no / snapshot) must
    // still be deleted by the caller — include their ids as side-car on the
    // first delivery of that type when present, else attach to a synthetic
    // bookkeeping entry via source_row_ids of all group rows minus kept.
    const keptIds = new Set(
      [
        ...plan.oddsChunks.flatMap((c) => c.source_row_ids),
        ...plan.nonOddsDeliveries.map((d) => d.row.id),
      ],
    );
    const droppedIds = group
      .map((g) => g.row.id)
      .filter((id) => !keptIds.has(id));
    if (droppedIds.length > 0 && out.length > 0) {
      // Attach dropped ids to the last delivery so flush deletes them once.
      const last = out[out.length - 1]!;
      last.source_row_ids = [...new Set([...last.source_row_ids, ...droppedIds])];
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
