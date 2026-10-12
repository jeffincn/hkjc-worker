import type { Env } from "../env";
import { envNum } from "../env";

/** Default headroom under Cloudflare's per-invocation subrequest cap. */
export const DEFAULT_SUBREQUEST_BUDGET = 45;

/**
 * Soft per-invocation subrequest counter.
 * Priority work (odds/lock/result GraphQL + enqueue) should still proceed;
 * heavy horse/runs/injury fetches defer when remaining budget is low.
 */
export class SubrequestBudget {
  used = 0;
  readonly limit: number;

  constructor(limit: number = DEFAULT_SUBREQUEST_BUDGET) {
    this.limit = Math.max(1, limit);
  }

  remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  /** True if charging `n` would stay within the limit. */
  canAfford(n = 1): boolean {
    return this.used + n <= this.limit;
  }

  /**
   * Record `n` subrequests. Returns false if the charge would exceed the
   * limit (counter is NOT incremented). Use `force` for priority work that
   * must run even when over budget (still increments for observability).
   */
  charge(n = 1, opts?: { force?: boolean }): boolean {
    if (!opts?.force && !this.canAfford(n)) return false;
    this.used += n;
    return true;
  }

  /** Remaining budget is too low for heavy HTML page work. */
  shouldDeferHeavy(): boolean {
    // Need room for at least one horse page + polite margin.
    return this.remaining() < 5;
  }
}

export function createSubrequestBudget(env: Env): SubrequestBudget {
  return new SubrequestBudget(envNum(env, "SUBREQUEST_BUDGET", DEFAULT_SUBREQUEST_BUDGET));
}
