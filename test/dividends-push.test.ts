import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  dividendsHashPayload,
  dividendsPoolCount,
  hasAnyDividends,
  poolHasDividends,
} from "../src/parse/dividends";
import { contentHash } from "../src/parse/hash";
import type { PmPoolRaw } from "../src/graphql/types";
import { storeDividendsAsResults } from "../src/store/db";
import { storeRawDocument } from "../src/store/horses";

/** Fixture shape from prod: 2026-10-14 HV — empty dividends, status churn. */
function emptyResPools(status: string, lastUpdateTime: string | null): PmPoolRaw[] {
  return [
    {
      oddsType: "WIN",
      status,
      lastUpdateTime,
      leg: { number: 1, races: [1] },
      dividends: [],
    },
    {
      oddsType: "PLA",
      status,
      lastUpdateTime,
      leg: { number: 1, races: [1] },
      dividends: [],
    },
    {
      oddsType: "WIN",
      status,
      lastUpdateTime,
      leg: { number: 2, races: [2] },
      dividends: [],
    },
  ];
}

function filledResPools(): PmPoolRaw[] {
  return [
    {
      oddsType: "WIN",
      status: "PAYOUT_STARTED",
      lastUpdateTime: "2026-10-14T19:05:00+08:00",
      leg: { number: 1, races: [1] },
      dividends: [{ winComb: "3", div: "47.5" }],
    },
    {
      oddsType: "PLA",
      status: "PAYOUT_STARTED",
      lastUpdateTime: "2026-10-14T19:05:00+08:00",
      leg: { number: 1, races: [1] },
      dividends: [
        { winComb: "3", div: "16.5" },
        { winComb: "7", div: "22.0" },
      ],
    },
  ];
}

describe("dividends push guards (pre-race empty pools)", () => {
  it("treats empty dividends arrays as no real dividends", () => {
    const pools = emptyResPools("DEFINED", "");
    expect(pools.every((p) => !poolHasDividends(p))).toBe(true);
    expect(hasAnyDividends(pools)).toBe(false);
    expect(dividendsPoolCount(pools)).toBe(0);
    expect(dividendsHashPayload(pools)).toEqual([]);
  });

  it("hash ignores INITIAL→DEFINED status churn when dividends stay empty", async () => {
    const initial = emptyResPools("INITIAL", null);
    const defined = emptyResPools("DEFINED", "");
    // Full raw payloads differ (status / lastUpdateTime), but meaningful hash is identical.
    expect(await contentHash(initial)).not.toBe(await contentHash(defined));
    expect(await contentHash(dividendsHashPayload(initial))).toBe(
      await contentHash(dividendsHashPayload(defined)),
    );
  });

  it("storeRawDocument with hashOf does not mark status-only churn as changed", async () => {
    const key = "2026-10-14_HV";
    const a = await storeRawDocument(
      env.DB,
      "graphql_dividends",
      key,
      emptyResPools("INITIAL", null),
      null,
      { hashOf: dividendsHashPayload(emptyResPools("INITIAL", null)) },
    );
    expect(a.changed).toBe(true);

    const b = await storeRawDocument(
      env.DB,
      "graphql_dividends",
      key,
      emptyResPools("DEFINED", ""),
      null,
      { hashOf: dividendsHashPayload(emptyResPools("DEFINED", "")) },
    );
    expect(b.changed).toBe(false);
    expect(b.content_hash).toBe(a.content_hash);

    // Push gate: changed alone is not enough — need non-empty dividends.
    expect(b.changed && hasAnyDividends(emptyResPools("DEFINED", ""))).toBe(false);
  });

  it("storeDividendsAsResults skips empty dividend shells", async () => {
    await storeDividendsAsResults(
      env.DB,
      "2026-10-14",
      "HV",
      1,
      emptyResPools("DEFINED", ""),
      "graphql",
    );
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM results WHERE meeting_date=? AND venue=? AND race_no=?`,
    )
      .bind("2026-10-14", "HV", 1)
      .first<{ n: number }>();
    expect(Number(row?.n ?? 0)).toBe(0);
  });

  it("pushes only when meaningful dividends appear", async () => {
    const key = "2026-10-14_HV_filled";
    const empty = emptyResPools("DEFINED", "");
    const first = await storeRawDocument(
      env.DB,
      "graphql_dividends",
      key,
      empty,
      null,
      { hashOf: dividendsHashPayload(empty) },
    );
    expect(first.changed && hasAnyDividends(empty)).toBe(false);

    const filled = filledResPools();
    const second = await storeRawDocument(
      env.DB,
      "graphql_dividends",
      key,
      filled,
      null,
      { hashOf: dividendsHashPayload(filled) },
    );
    expect(second.changed).toBe(true);
    expect(hasAnyDividends(filled)).toBe(true);
    expect(dividendsPoolCount(filled)).toBe(2);
    expect(second.content_hash).not.toBe(first.content_hash);

    await storeDividendsAsResults(env.DB, "2026-10-14", "HV", 1, filled, "graphql");
    const row = await env.DB.prepare(
      `SELECT dividends_json FROM results WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?`,
    )
      .bind("2026-10-14", "HV", 1, 3)
      .first<{ dividends_json: string }>();
    expect(row?.dividends_json).toBeTruthy();
    expect(JSON.parse(row!.dividends_json)[0].dividends[0].div).toBe("47.5");
  });
});
