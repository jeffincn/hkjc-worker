/**
 * Barrier draw integrity (issue #33).
 *
 * Worker maps `barrierDrawNumber` → `barrier` with no remapping. When HKJC
 * GraphQL returns duplicates / gaps, we keep the raw values (official draw is
 * authoritative — never invent corrections) and flag the race unreliable.
 */
import { isScratchedStatus } from "./meeting";

export const BARRIER_INTEGRITY_META_KEY = "barrier_integrity_violations";

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
  /** Unique barrier values among field runners (sorted). */
  barriers: number[];
  duplicates: number[];
  missing: number[];
  /** True when set ≠ {1..field_size} (source-side or stale mapping). */
  barrier_unreliable: boolean;
  /** Origin note for operators / API consumers. */
  origin: "hkjc_graphql_barrierDrawNumber";
  raw_evidence: BarrierEvidenceRow[];
}

export function isStandbyStatus(status: string | null | undefined): boolean {
  return (status ?? "").toUpperCase().includes("STANDBY");
}

/** Runners that should hold a permutation of barriers 1..N. */
export function barrierFieldRunners<T extends BarrierRunnerView>(runners: T[]): T[] {
  return runners.filter(
    (r) => !isScratchedStatus(r.status) && !isStandbyStatus(r.status),
  );
}

/**
 * Assert barrier set among field runners == {1..field_size}.
 * Does not mutate or invent barriers — diagnostic only.
 */
export function checkBarrierIntegrity(
  runners: BarrierRunnerView[],
): BarrierIntegrityResult {
  const field = barrierFieldRunners(runners);
  const field_size = field.length;
  const raw_evidence: BarrierEvidenceRow[] = field.map((r) => ({
    horse_no: r.horse_no,
    status: r.status,
    barrier: r.barrier,
    barrierDrawNumber:
      r.barrierDrawNumber !== undefined
        ? r.barrierDrawNumber
        : r.barrier,
    name_en: r.name_en ?? null,
  }));

  if (field_size === 0) {
    return {
      ok: true,
      field_size: 0,
      barriers: [],
      duplicates: [],
      missing: [],
      barrier_unreliable: false,
      origin: "hkjc_graphql_barrierDrawNumber",
      raw_evidence: [],
    };
  }

  const expected = new Set(
    Array.from({ length: field_size }, (_, i) => i + 1),
  );
  const counts = new Map<number, number>();
  for (const r of field) {
    if (r.barrier == null || !Number.isFinite(r.barrier) || r.barrier <= 0) {
      continue;
    }
    counts.set(r.barrier, (counts.get(r.barrier) ?? 0) + 1);
  }

  const barriers = [...counts.keys()].sort((a, b) => a - b);
  const duplicates = barriers.filter((b) => (counts.get(b) ?? 0) > 1);
  const missing = [...expected].filter((n) => !counts.has(n));
  // Also treat null / non-positive among field as integrity failure (gap).
  const nullish = field.filter(
    (r) => r.barrier == null || !Number.isFinite(r.barrier) || r.barrier <= 0,
  );
  if (nullish.length > 0) {
    for (const n of expected) {
      if (!counts.has(n) && !missing.includes(n)) missing.push(n);
    }
    missing.sort((a, b) => a - b);
  }

  const ok =
    duplicates.length === 0 &&
    missing.length === 0 &&
    barriers.length === field_size &&
    barriers.every((b) => expected.has(b)) &&
    nullish.length === 0;

  return {
    ok,
    field_size,
    barriers,
    duplicates,
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
  duplicates: number[];
  missing: number[];
  raw_evidence: BarrierEvidenceRow[];
  origin: "hkjc_graphql_barrierDrawNumber";
  updated_at: string;
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
