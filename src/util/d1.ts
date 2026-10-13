/**
 * D1 rejects JavaScript `undefined` binds with:
 *   D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'
 * Always coerce undefined → null before .bind().
 */
export function asD1Value<T>(v: T | undefined): T | null {
  return v === undefined ? null : v;
}

/** Bind values with undefined coerced to null. */
export function d1Bind(
  stmt: D1PreparedStatement,
  ...values: unknown[]
): D1PreparedStatement {
  return stmt.bind(...values.map((v) => (v === undefined ? null : v)));
}

/** True when an error is D1 / storage infrastructure — not HKJC source. */
export function isStorageOrInfraError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.toLowerCase();
  return (
    m.includes("d1_type_error") ||
    m.includes("d1_") ||
    m.includes("d1 ") ||
    m.includes("storage") ||
    m.includes("row write limit") ||
    m.includes("rows written") ||
    m.includes("quota") ||
    m.includes("too many requests to d1") ||
    (m.includes("exceeded the") && m.includes("d1"))
  );
}

/** Extract rows_written estimate from a D1 run result. */
export function rowsWrittenFromMeta(meta: D1Meta | undefined | null): number {
  if (!meta) return 0;
  const m = meta as D1Meta & { rows_written?: number; changes?: number };
  const n = m.rows_written ?? m.changes ?? 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
