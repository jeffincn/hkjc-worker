/**
 * HKJC brand horse numbers (e.g. H087, V123) — letter + 3 digits.
 * Used as the stable key for hkjc-model / /v1/horses/:code.
 */

const BRAND_CODE_RE = /^[A-Za-z]\d{3}$/;

/** True when `s` looks like an HKJC brand code (H087). */
export function isHkjcHorseCode(s: string | null | undefined): boolean {
  if (s == null) return false;
  return BRAND_CODE_RE.test(String(s).trim());
}

/** Normalize to uppercase brand code or null. */
export function normalizeHorseCode(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().toUpperCase();
  return isHkjcHorseCode(s) ? s : null;
}

/**
 * Prefer GraphQL `horse.code`; if `runner_id` itself is a brand code, use that
 * (odds snapshots store runner_id = horse.code when available).
 */
export function horseCodeFromRunnerFields(fields: {
  horse_code?: string | null;
  horse?: { code?: string | null } | null;
  runner_id?: string | null;
}): string | null {
  return (
    normalizeHorseCode(fields.horse_code) ??
    normalizeHorseCode(fields.horse?.code) ??
    normalizeHorseCode(fields.runner_id)
  );
}
