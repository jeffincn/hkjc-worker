/**
 * Shared byte-budget pagination for large GET responses (issue #38 A2 / P1).
 *
 * Default and hard cap: 1_200_000 bytes (runner collector limit).
 * Always returns at least one item when the input is non-empty so cursors advance.
 *
 * **Byte unit:** `max_bytes` counts **uncompressed raw JSON UTF-8 bytes**
 * (`TextEncoder` / wire body before any Content-Encoding). Not gzip size,
 * not JS string `.length` (UTF-16 code units).
 */

/** Default + max response budget for /v1/events and /v1/odds/snapshots. */
export const QUERY_MAX_BYTES_DEFAULT = 1_200_000;
export const QUERY_MAX_BYTES_CAP = 1_200_000;

const utf8 = new TextEncoder();

/** Uncompressed UTF-8 byte length of a string (raw JSON body metric). */
export function utf8ByteLength(s: string): number {
  return utf8.encode(s).byteLength;
}

export function clampMaxBytes(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return QUERY_MAX_BYTES_DEFAULT;
  const n = Math.floor(Number(raw));
  if (n < 1) return 1;
  return Math.min(n, QUERY_MAX_BYTES_CAP);
}

/**
 * Pack items under an uncompressed UTF-8 JSON byte budget.
 * Stops before exceeding maxBytes when at least one item is already packed;
 * if the first item alone exceeds the budget, still returns that one item
 * so the client can advance the cursor.
 */
export function packItemsUnderBudget<T>(args: {
  items: T[];
  encodeOne: (item: T) => string;
  /** Fixed overhead for envelope JSON around the array (UTF-8 bytes). */
  envelopeOverheadBytes?: number;
  maxBytes?: number;
}): { items: T[]; truncated_by_bytes: boolean } {
  const maxBytes = args.maxBytes ?? QUERY_MAX_BYTES_DEFAULT;
  const overhead = args.envelopeOverheadBytes ?? 512;
  const out: T[] = [];
  let used = overhead + 2; // []
  for (let i = 0; i < args.items.length; i++) {
    const item = args.items[i]!;
    const chunk = args.encodeOne(item);
    const add = utf8ByteLength(chunk) + (out.length > 0 ? 1 : 0); // comma
    if (out.length > 0 && used + add > maxBytes) {
      return { items: out, truncated_by_bytes: true };
    }
    if (out.length === 0 && used + add > maxBytes) {
      out.push(item);
      return { items: out, truncated_by_bytes: args.items.length > 1 };
    }
    out.push(item);
    used += add;
  }
  return { items: out, truncated_by_bytes: false };
}
