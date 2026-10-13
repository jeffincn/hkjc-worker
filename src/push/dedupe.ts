/**
 * Push dedupe: last-pushed odds state, body content hashes (volatile fields
 * stripped), and helpers so identical content is never re-delivered.
 */
import type { Env } from "../env";
import { contentHash } from "../parse/hash";
import { getMeta, setMeta } from "../store/db";
import type {
  OddsBetType,
  OddsDeltaChange,
  PushEnvelope,
  PushRace,
} from "./envelope";

/** runner_id|WIN|PLA → last pushed odds value. */
export type LastPushedOdds = Record<string, number | null>;

export function oddsPushKey(runnerId: string, pool: OddsBetType): string {
  return `${runnerId}|${pool}`;
}

/**
 * Keep only changes whose new_odds differ from last-pushed (not last-polled).
 * Empty input / all-equal → empty changes (caller must not emit).
 */
export function filterChangesAgainstLastPushed(
  changes: OddsDeltaChange[],
  last: LastPushedOdds,
): { changes: OddsDeltaChange[]; next: LastPushedOdds } {
  const next: LastPushedOdds = { ...last };
  const out: OddsDeltaChange[] = [];
  for (const c of changes) {
    const runnerId = c.runner_id?.trim();
    if (!runnerId) continue;
    const pool = (c.pool ?? c.bet_type) as OddsBetType;
    if (pool !== "WIN" && pool !== "PLA") continue;
    const key = oddsPushKey(runnerId, pool);
    const prevPushed = Object.prototype.hasOwnProperty.call(next, key)
      ? next[key]!
      : undefined;
    // First push for this key always emits; thereafter require value change.
    if (prevPushed !== undefined && sameOdds(prevPushed, c.new_odds)) {
      continue;
    }
    out.push(c);
    next[key] = c.new_odds ?? null;
  }
  return { changes: out, next };
}

/** Numeric equality that treats null/undefined as equal and ignores -0. */
export function sameOdds(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Object.is(a, b) || a === b;
}

/**
 * Apply emitted changes onto last-pushed state (after a successful odds_delta).
 */
export function applyEmittedChangesToLastPushed(
  last: LastPushedOdds,
  changes: OddsDeltaChange[],
): LastPushedOdds {
  const next = { ...last };
  for (const c of changes) {
    const runnerId = c.runner_id?.trim();
    if (!runnerId) continue;
    const pool = (c.pool ?? c.bet_type) as OddsBetType;
    if (pool !== "WIN" && pool !== "PLA") continue;
    next[oddsPushKey(runnerId, pool)] = c.new_odds ?? null;
  }
  return next;
}

/** Seed last-pushed from a full snapshot races[] (after odds_update). */
export function lastPushedFromRaces(races: PushRace[]): LastPushedOdds {
  const out: LastPushedOdds = {};
  for (const race of races) {
    for (const r of race.runners ?? []) {
      const id = r.runner_id?.trim();
      if (!id) continue;
      out[oddsPushKey(id, "WIN")] = r.win_odds ?? null;
      out[oddsPushKey(id, "PLA")] = r.place_odds ?? null;
    }
  }
  return out;
}

/**
 * Stable hash payload for an envelope: strips timestamps, seq, event_id,
 * late_ms, and per-change observation annotations.
 */
export function stablePushBody(envelope: PushEnvelope): unknown {
  const changes = envelope.changes?.map((c) => ({
    race_no: c.race_no,
    runner_id: c.runner_id ?? null,
    horse_no: c.horse_no ?? c.runner_no,
    status: c.status ?? null,
    bet_type: c.bet_type,
    pool: c.pool ?? c.bet_type,
    prev_odds: c.prev_odds,
    new_odds: c.new_odds,
    pool_status: c.pool_status ?? null,
  }));
  const races = (envelope.races ?? []).map(stableRace);
  return {
    schema: envelope.schema,
    event: envelope.event,
    meeting_date: envelope.meeting_date,
    venue: envelope.venue,
    races,
    changes: changes ?? null,
    pools: envelope.pools ?? null,
    last_change_seq: envelope.last_change_seq ?? null,
    // meta without volatile keepalive flags that change without content
    meta: stableMeta(envelope.meta),
  };
}

function stableRace(r: PushRace): unknown {
  return {
    race_no: r.race_no,
    post_time: r.post_time,
    pool_status: r.pool_status,
    runners: (r.runners ?? []).map((x) => ({
      runner_id: x.runner_id ?? null,
      horse_no: x.horse_no,
      win_odds: x.win_odds,
      place_odds: x.place_odds,
      status: x.status,
      final_position: x.final_position,
    })),
  };
}

function stableMeta(meta: Record<string, unknown> | undefined): unknown {
  if (!meta) return null;
  const {
    keepalive: _k,
    merged_heartbeat: _m,
    raceday_high_freq: _r,
    heartbeat_interval_sec: _h,
    ...rest
  } = meta;
  return Object.keys(rest).length > 0 ? rest : null;
}

export async function pushBodyContentHash(envelope: PushEnvelope): Promise<string> {
  return contentHash(stablePushBody(envelope));
}

export async function oddsUpdateRacesHash(races: PushRace[]): Promise<string> {
  return contentHash(races.map(stableRace));
}

function meetingKey(meetingDate: string, venue: string): string {
  return `${meetingDate}_${venue}`;
}

export function lastPushedOddsMetaKey(meetingDate: string, venue: string): string {
  return `last_pushed_odds_${meetingKey(meetingDate, venue)}`;
}

export function lastOddsUpdateHashMetaKey(meetingDate: string, venue: string): string {
  return `last_odds_update_hash_${meetingKey(meetingDate, venue)}`;
}

export function lastSubBodyHashMetaKey(
  subscriberId: number | null,
  event: string,
): string {
  const sub = subscriberId == null ? "fallback" : String(subscriberId);
  return `push_body_hash_${sub}_${event}`;
}

export async function loadLastPushedOdds(
  db: D1Database,
  meetingDate: string,
  venue: string,
): Promise<LastPushedOdds> {
  const raw = await getMeta(db, lastPushedOddsMetaKey(meetingDate, venue));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as LastPushedOdds;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveLastPushedOdds(
  env: Env,
  meetingDate: string,
  venue: string,
  state: LastPushedOdds,
): Promise<void> {
  await setMeta(
    env.DB,
    lastPushedOddsMetaKey(meetingDate, venue),
    JSON.stringify(state),
  );
}

export async function loadLastOddsUpdateHash(
  db: D1Database,
  meetingDate: string,
  venue: string,
): Promise<string | null> {
  return getMeta(db, lastOddsUpdateHashMetaKey(meetingDate, venue));
}

export async function saveLastOddsUpdateHash(
  env: Env,
  meetingDate: string,
  venue: string,
  hash: string,
): Promise<void> {
  await setMeta(env.DB, lastOddsUpdateHashMetaKey(meetingDate, venue), hash);
}

/** Events subject to per-subscriber identical-body suppression. */
export function isBodyDedupeEvent(event: string): boolean {
  return event === "odds_update" || event === "odds_delta";
}

/**
 * True when this subscriber already received an identical stable body for
 * this event type (last hash match). Only odds_update / odds_delta.
 */
export async function isDuplicateBodyForSubscriber(
  env: Env,
  subscriberId: number | null,
  event: string,
  bodyHash: string,
): Promise<boolean> {
  if (!isBodyDedupeEvent(event)) return false;
  const prev = await getMeta(env.DB, lastSubBodyHashMetaKey(subscriberId, event));
  return prev != null && prev === bodyHash;
}

export async function rememberBodyHashForSubscriber(
  env: Env,
  subscriberId: number | null,
  event: string,
  bodyHash: string,
): Promise<void> {
  if (!isBodyDedupeEvent(event)) return;
  await setMeta(env.DB, lastSubBodyHashMetaKey(subscriberId, event), bodyHash);
}
