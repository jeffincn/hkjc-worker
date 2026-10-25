import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  isEmptyPreSaleSnapshot,
  isRaceNearOrPastPost,
  isStorableOddsSnapshot,
  LOCK_POST_TIME_WINDOW_MS,
  shouldEmitLock,
  snapshotHasOdds,
} from "../src/parse/lock";
import { buildRaceOddsSnapshot } from "../src/parse/odds";
import { resultsComplete } from "../src/parse/meeting";
import type { RaceRaw } from "../src/graphql/types";
import {
  insertOddsSnapshotIfChanged,
  raceHadOpenOddsSnapshot,
} from "../src/store/db";

/** Far-future evening card like 2026-10-14 HV (post 18:35+), ingested mid-day. */
const FUTURE_POST = "2026-10-14T18:35:00+08:00";
/** Mid-day on 2026-10-12 — days before the meeting. */
const NOW_MIDDAY = Date.parse("2026-10-12T15:02:00+08:00");

function preSaleRace(raceNo = 1): RaceRaw {
  return {
    no: raceNo,
    postTime: FUTURE_POST,
    runners: [
      { no: "1", name_en: "A", status: "Declared" },
      { no: "2", name_en: "B", status: "Declared" },
    ],
  };
}

describe("lock guards (pre-sale STOP_SELL)", () => {
  it("builds empty-lastUpdate STOP_SELL as a non-storable pre-sale shell", () => {
    const snap = buildRaceOddsSnapshot({
      race: preSaleRace(),
      winPool: {
        oddsType: "WIN",
        sellStatus: "STOP_SELL",
        lastUpdateTime: "",
        oddsNodes: [],
      },
      plaPool: {
        oddsType: "PLA",
        sellStatus: "STOP_SELL",
        lastUpdateTime: "",
        oddsNodes: [],
      },
    });
    // Empty lastUpdateTime must not become snapshot_time ""
    expect(snap.payload.last_update).toBeNull();
    expect(snap.snapshot_time).not.toBe("");
    expect(snapshotHasOdds(snap)).toBe(false);
    expect(isEmptyPreSaleSnapshot(snap)).toBe(true);
    expect(isStorableOddsSnapshot(snap)).toBe(false);
  });

  it("does not treat far-future post time as lock-eligible", () => {
    expect(isRaceNearOrPastPost(FUTURE_POST, NOW_MIDDAY)).toBe(false);
    expect(
      shouldEmitLock({
        poolStatus: "STOP_SELL",
        postTime: FUTURE_POST,
        nowMs: NOW_MIDDAY,
        wasOpenOrHasOdds: false,
      }),
    ).toBe(false);
  });

  it("requires near/past post AND prior open (or current odds) for lock", () => {
    const nearPost = "2026-10-14T18:30:00+08:00";
    const now = Date.parse("2026-10-14T18:32:00+08:00");
    expect(isRaceNearOrPastPost(nearPost, now)).toBe(true);

    expect(
      shouldEmitLock({
        poolStatus: "STOP_SELL",
        postTime: nearPost,
        nowMs: now,
        wasOpenOrHasOdds: false,
      }),
    ).toBe(false);

    expect(
      shouldEmitLock({
        poolStatus: "STOP_SELL",
        postTime: nearPost,
        nowMs: now,
        wasOpenOrHasOdds: true,
      }),
    ).toBe(true);

    // Outside the 15-minute window before post
    const early = now - LOCK_POST_TIME_WINDOW_MS - 60_000;
    const postLater = new Date(early + LOCK_POST_TIME_WINDOW_MS + 60_000).toISOString();
    expect(
      shouldEmitLock({
        poolStatus: "STOP_SELL",
        postTime: postLater,
        nowMs: early,
        wasOpenOrHasOdds: true,
      }),
    ).toBe(false);
  });

  it("does not store empty pre-sale STOP_SELL snapshots (prod shape)", async () => {
    const snap = buildRaceOddsSnapshot({
      race: preSaleRace(3),
      winPool: {
        oddsType: "WIN",
        sellStatus: "STOP_SELL",
        lastUpdateTime: "",
        oddsNodes: [],
      },
    });
    expect(isStorableOddsSnapshot(snap)).toBe(false);

    // Caller skips insert; if somehow inserted, raceHadOpen would still be false.
    if (isStorableOddsSnapshot(snap)) {
      await insertOddsSnapshotIfChanged(env.DB, "2026-10-14", "HV", snap);
    }
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM odds_snapshots WHERE meeting_date=? AND venue=? AND race_no=?`,
    )
      .bind("2026-10-14", "HV", 3)
      .first<{ n: number }>();
    expect(Number(count?.n ?? 0)).toBe(0);
  });

  it("emits lock after START_SELL→STOP_SELL near post time", async () => {
    const race = preSaleRace(5);
    const post = "2026-10-14T18:35:00+08:00";
    race.postTime = post;
    const now = Date.parse("2026-10-14T18:34:00+08:00");

    const selling = buildRaceOddsSnapshot({
      race,
      winPool: {
        oddsType: "WIN",
        sellStatus: "START_SELL",
        lastUpdateTime: "2026-10-14T17:00:00+08:00",
        oddsNodes: [
          { combString: "01", oddsValue: "3.5" },
          { combString: "02", oddsValue: "8.0" },
        ],
      },
    });
    expect(isStorableOddsSnapshot(selling)).toBe(true);
    const a = await insertOddsSnapshotIfChanged(env.DB, "2026-10-14", "HV", selling);
    expect(a.inserted).toBe(true);

    const locked = buildRaceOddsSnapshot({
      race,
      winPool: {
        oddsType: "WIN",
        sellStatus: "STOP_SELL",
        lastUpdateTime: "2026-10-14T18:33:00+08:00",
        oddsNodes: [
          { combString: "01", oddsValue: "3.2" },
          { combString: "02", oddsValue: "7.5" },
        ],
      },
    });
    const hadPrior = await raceHadOpenOddsSnapshot(env.DB, "2026-10-14", "HV", 5);
    expect(hadPrior).toBe(true);
    expect(
      shouldEmitLock({
        poolStatus: locked.pool_status,
        postTime: locked.post_time,
        nowMs: now,
        wasOpenOrHasOdds: snapshotHasOdds(locked) || hadPrior,
      }),
    ).toBe(true);

    const b = await insertOddsSnapshotIfChanged(env.DB, "2026-10-14", "HV", locked);
    expect(b.inserted).toBe(true);
  });

  it("resultsComplete does not fire pre-race (no final positions)", () => {
    expect(
      resultsComplete({
        race_no: 1,
        post_time: FUTURE_POST,
        status: "DEFINED",
        distance: null,
        going: null,
        course_desc: null,
        course_code: null,
        race_class: null,
        runners: [
          {
            horse_no: 1,
            is_standby: false,
            standby_no: null,
            horse_code: "H001",
            horse_id: null,
            name_en: "A",
            name_ch: null,
            status: "Declared",
            barrier: null,
            handicap_weight: null,
            jockey_en: null,
            trainer_en: null,
            last6run: null,
            final_position: null,
            dead_heat: null,
            win_odds: null,
          },
        ],
      }),
    ).toBe(false);
  });
});
