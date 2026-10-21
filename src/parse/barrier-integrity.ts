/**
 * Barrier draw integrity (issue #33).
 *
 * Worker maps `barrierDrawNumber` → `barrier` with no remapping. HKJC keeps
 * original draws when horses scratch, so declared barriers need not be a
 * dense 1..field_size permutation — gaps from scratches are OK.
 *
 * Scratched runners are sometimes omitted entirely from GraphQL / D1, so
 * `draw_size` must not rely only on present runner count — infer from
 * max(horse_no), max(barrier ≤ HKJC_MAX_FIELD_SIZE), and wageringFieldSize.
 *
 * True violations:
 * - duplicate barrier among declared (non-scratch / non-standby) runners
 * - barrier outside 1..draw_size
 * - declared runner missing a barrier value
 */
import { isScratchedStatus } from "./meeting";

export const BARRIER_INTEGRITY_META_KEY = "barrier_integrity_violations";

/** HKJC turf max starters / barrier numbers. */
export const HKJC_MAX_FIELD_SIZE = 14;

export interface BarrierRunnerView {
  horse_no: number;
  status: string | null;
  /** Stored / normalized barrier (from barrierDrawNumber). */
  barrier: number | null;
  /** Raw GraphQL barrierDrawNumber when available (evidence). */
  barrierDrawNumber?: string | number | null;
  name_en?: string | null;
}

export interface BarrierEvidenceRow {
  horse_no: number;
  status: string | null;
  barrier: number | null;
  barrierDrawNumber: string | number | null;
  name_en?: string | null;
}

export interface BarrierIntegrityResult {
  ok: boolean;
  /** Declared (non-scratch / non-standby) runner count. */
  field_size: number;
  /**
   * Inferred original draw size (1..draw_size is the valid barrier range).
   * See inferDrawSize — not merely present runner count.
   */
  draw_size: number;
  /** Unique barrier values among declared runners (sorted). */
  barriers: number[];
  duplicates: number[];
  /** Barriers on declared runners outside 1..draw_size. */
  out_of_range: number[];
  /** Declared horse_no values with null / non-positive barrier. */
  null_barrier_horse_nos: number[];
  /**
   * Numbers in 1..draw_size not held by any declared runner (often scratch
   * gaps). Informational only — does NOT set barrier_unreliable.
   */
  missing: number[];
  /** True on duplicate / out-of-range / null barrier among declared. */
  barrier_unreliable: boolean;
  /** Origin note for operators / API consumers. */
  origin: "hkjc_graphql_barrierDrawNumber";
  raw_evidence: BarrierEvidenceRow[];
}

export function isStandbyStatus(status: string | null | undefined): boolean {
  return (status ?? "").toUpperCase().includes("STANDBY");
}

/** Declared runners that must each carry a valid barrier. */
export function barrierFieldRunners<T extends BarrierRunnerView>(runners: T[]): T[] {
  return runners.filter(
    (r) => !isScratchedStatus(r.status) && !isStandbyStatus(r.status),
  );
}

/** Non-standby runners (declared + scratched) present in the payload. */
export function barrierDrawRunners<T extends BarrierRunnerView>(runners: T[]): T[] {
  return runners.filter((r) => !isStandbyStatus(r.status));
}

export interface BarrierIntegrityOptions {
  /** GraphQL race.wageringFieldSize when known (preferred hint). */
  wageringFieldSize?: number | null;
}

/**
 * Infer original field / barrier range when scratched horses may be absent.
 * draw_size = max(present non-standby count, max(horse_no), max(barrier≤14),
 *                 wageringFieldSize≤14).
 */
export function inferDrawSize(
  runners: BarrierRunnerView[],
  opts?: BarrierIntegrityOptions,
): number {
  const drawPool = barrierDrawRunners(runners);
  const field = barrierFieldRunners(runners);

  let maxHorseNo = 0;
  for (const r of drawPool) {
    if (Number.isFinite(r.horse_no) && r.horse_no > 0) {
      maxHorseNo = Math.max(maxHorseNo, r.horse_no);
    }
  }

  // Only barriers within the HKJC max contribute — a corrupt 99 must not
  // inflate draw_size and hide the out-of-range flag.
  let maxBarrierHint = 0;
  for (const r of field) {
    if (
      r.barrier != null &&
      Number.isFinite(r.barrier) &&
      r.barrier >= 1 &&
      r.barrier <= HKJC_MAX_FIELD_SIZE
    ) {
      maxBarrierHint = Math.max(maxBarrierHint, r.barrier);
    }
  }

  let wageringHint = 0;
  const w = opts?.wageringFieldSize;
  if (w != null && Number.isFinite(w) && w > 0) {
    wageringHint = Math.min(Math.floor(w), HKJC_MAX_FIELD_SIZE);
  }

  return Math.max(drawPool.length, maxHorseNo, maxBarrierHint, wageringHint);
}

function evidenceRow(r: BarrierRunnerView): BarrierEvidenceRow {
  return {
    horse_no: r.horse_no,
    status: r.status,
    barrier: r.barrier,
    barrierDrawNumber:
      r.barrierDrawNumber !== undefined ? r.barrierDrawNumber : r.barrier,
    name_en: r.name_en ?? null,
  };
}

/**
 * Barrier integrity for one race. Does not mutate or invent barriers.
 */
export function checkBarrierIntegrity(
  runners: BarrierRunnerView[],
  opts?: BarrierIntegrityOptions,
): BarrierIntegrityResult {
  const field = barrierFieldRunners(runners);
  const drawPool = barrierDrawRunners(runners);
  const field_size = field.length;
  const draw_size = inferDrawSize(runners, opts);
  // Evidence: declared first, then scratched (for draw_size context).
  const scratched = drawPool.filter((r) => isScratchedStatus(r.status));
  const raw_evidence: BarrierEvidenceRow[] = [
    ...field.map(evidenceRow),
    ...scratched.map(evidenceRow),
  ];

  if (field_size === 0) {
    return {
      ok: true,
      field_size: 0,
      draw_size,
      barriers: [],
      duplicates: [],
      out_of_range: [],
      null_barrier_horse_nos: [],
      missing: [],
      barrier_unreliable: false,
      origin: "hkjc_graphql_barrierDrawNumber",
      raw_evidence,
    };
  }

  const counts = new Map<number, number>();
  const null_barrier_horse_nos: number[] = [];
  for (const r of field) {
    if (r.barrier == null || !Number.isFinite(r.barrier) || r.barrier <= 0) {
      null_barrier_horse_nos.push(r.horse_no);
      continue;
    }
    counts.set(r.barrier, (counts.get(r.barrier) ?? 0) + 1);
  }

  const barriers = [...counts.keys()].sort((a, b) => a - b);
  const duplicates = barriers.filter((b) => (counts.get(b) ?? 0) > 1);
  const out_of_range = barriers.filter(
    (b) => draw_size > 0 && (b < 1 || b > draw_size),
  );

  // Informational gaps (scratch holes); not a violation by themselves.
  const expected =
    draw_size > 0
      ? Array.from({ length: draw_size }, (_, i) => i + 1)
      : [];
  const missing = expected.filter((n) => !counts.has(n));

  const ok =
    duplicates.length === 0 &&
    out_of_range.length === 0 &&
    null_barrier_horse_nos.length === 0;

  return {
    ok,
    field_size,
    draw_size,
    barriers,
    duplicates,
    out_of_range,
    null_barrier_horse_nos,
    missing,
    barrier_unreliable: !ok,
    origin: "hkjc_graphql_barrierDrawNumber",
    raw_evidence,
  };
}

export interface BarrierViolationRecord {
  meeting_date: string;
  venue: string;
  race_no: number;
  field_size: number;
  draw_size: number;
  duplicates: number[];
  out_of_range: number[];
  null_barrier_horse_nos: number[];
  /** Informational scratch gaps; not a violation cause. */
  missing: number[];
  raw_evidence: BarrierEvidenceRow[];
  origin: "hkjc_graphql_barrierDrawNumber";
  updated_at: string;
}

export function violationFromIntegrity(
  meetingDate: string,
  venue: string,
  raceNo: number,
  integrity: BarrierIntegrityResult,
  updatedAt = new Date().toISOString(),
): BarrierViolationRecord | null {
  if (integrity.ok) return null;
  return {
    meeting_date: meetingDate,
    venue,
    race_no: raceNo,
    field_size: integrity.field_size,
    draw_size: integrity.draw_size,
    duplicates: integrity.duplicates,
    out_of_range: integrity.out_of_range,
    null_barrier_horse_nos: integrity.null_barrier_horse_nos,
    missing: integrity.missing,
    raw_evidence: integrity.raw_evidence,
    origin: integrity.origin,
    updated_at: updatedAt,
  };
}

/** Merge/replace one race violation into a meeting-level list. */
export function upsertBarrierViolation(
  existing: BarrierViolationRecord[],
  next: BarrierViolationRecord | null,
  raceNo: number,
): BarrierViolationRecord[] {
  const rest = existing.filter((v) => v.race_no !== raceNo);
  if (next == null) return rest;
  return [...rest, next].sort((a, b) => a.race_no - b.race_no);
}

export function sortBarrierViolations(
  records: BarrierViolationRecord[],
): BarrierViolationRecord[] {
  return [...records].sort((a, b) => {
    const d = a.meeting_date.localeCompare(b.meeting_date);
    if (d !== 0) return d;
    const v = a.venue.localeCompare(b.venue);
    if (v !== 0) return v;
    return a.race_no - b.race_no;
  });
}

/** Payload shape attached to each race on /v1/races. */
export function barrierIntegrityPayload(integrity: BarrierIntegrityResult) {
  return {
    ok: integrity.ok,
    field_size: integrity.field_size,
    draw_size: integrity.draw_size,
    barriers: integrity.barriers,
    duplicates: integrity.duplicates,
    out_of_range: integrity.out_of_range,
    null_barrier_horse_nos: integrity.null_barrier_horse_nos,
    missing: integrity.missing,
    origin: integrity.origin,
    raw_evidence: integrity.raw_evidence,
  };
}
