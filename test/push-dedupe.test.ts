import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
  filterChangesAgainstLastPushed,
  lastPushedFromRaces,
  loadLastOddsUpdateHash,
  oddsUpdateRacesHash,
  pushBodyContentHash,
  sameOdds,
  saveLastOddsUpdateHash,
  stablePushBody,
  type LastPushedOdds,
} from "../src/push/dedupe";
import { deliverToTarget } from "../src/push/delivery";
import { buildEnvelope, ODDS_BASIS, type OddsDeltaChange, type PushRace } from "../src/push/envelope";
import {
  DEFAULT_PUSH_OFFWINDOW_COALESCE_SEC,
  resolveCoalesceMs,
} from "../src/push/odds-policy";
import { emitOddsUpdateIfChanged } from "../src/push/odds-emit";
import { createSubscriber } from "../src/push/subscribers";

function change(partial: Partial<OddsDeltaChange> & { runner_id: string }): OddsDeltaChange {
  return {
    race_no: partial.race_no ?? 1,
    runner_no: partial.runner_no ?? 1,
    runner_id: partial.runner_id,
    horse_no: partial.horse_no ?? 1,
    horse_name_ch: null,
    horse_name_en: "A",
    status: partial.status ?? "Declared",
    bet_type: partial.bet_type ?? "WIN",
    pool: partial.pool ?? partial.bet_type ?? "WIN",
    odds_basis: ODDS_BASIS,
    prev_odds: partial.prev_odds ?? 4,
    new_odds: partial.new_odds ?? 3.5,
    source_last_updated_at: null,
    race_post_time: null,
    pool_status: "START_SELL",
  };
}

function race(runners: PushRace["runners"]): PushRace {
  return {
    race_no: 1,
    post_time: "2026-10-14T20:00:00+08:00",
    snapshot_time: "2026-10-13T12:00:00+08:00",
    pool_status: "START_SELL",
    runners,
  };
}

describe("filterChangesAgainstLastPushed", () => {
  it("drops empty and equal-to-last-pushed odds", () => {
    const last: LastPushedOdds = {
      "H001|WIN": 3.5,
      "H001|PLA": 1.4,
    };
    const { changes, next } = filterChangesAgainstLastPushed(
      [
        change({ runner_id: "H001", bet_type: "WIN", new_odds: 3.5 }),
        change({ runner_id: "H001", bet_type: "PLA", new_odds: 1.4 }),
        change({ runner_id: "H002", bet_type: "WIN", new_odds: 10 }),
      ],
      last,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.runner_id).toBe("H002");
    expect(next["H002|WIN"]).toBe(10);
    expect(next["H001|WIN"]).toBe(3.5);
  });

  it("does not re-emit standby/declared flip-flop with same odds", () => {
    const last: LastPushedOdds = { "H001|WIN": 5.0 };
    // Poll-side prev differed (flip-flop), but last-pushed already has 5.0.
    const { changes } = filterChangesAgainstLastPushed(
      [change({ runner_id: "H001", bet_type: "WIN", prev_odds: null, new_odds: 5.0 })],
      last,
    );
    expect(changes).toHaveLength(0);
  });

  it("sameOdds treats nulls as equal", () => {
    expect(sameOdds(null, null)).toBe(true);
    expect(sameOdds(1.5, 1.5)).toBe(true);
    expect(sameOdds(1.5, 1.6)).toBe(false);
  });
});

describe("stable body hash / subscriber dedupe", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM worker_meta`).run();
    await env.DB.prepare(`DELETE FROM push_log`).run();
    await env.DB.prepare(`DELETE FROM push_subscribers`).run();
  });

  it("strips timestamps/seq so identical content hashes equal", async () => {
    const races = [
      race([
        {
          runner_id: "H001",
          horse_no: 1,
          horse_name: "A",
          win_odds: 3.5,
          place_odds: 1.4,
          status: "Declared",
          final_position: null,
        },
      ]),
    ];
    const a = buildEnvelope({
      event: "odds_update",
      meeting_date: "2026-10-14",
      venue: "HV",
      races,
      event_id: "aaa",
      seq: 1,
      captured_at: "2026-10-13T12:00:00+08:00",
      sent_at: "2026-10-13T12:00:01+08:00",
    });
    const b = buildEnvelope({
      event: "odds_update",
      meeting_date: "2026-10-14",
      venue: "HV",
      races,
      event_id: "bbb",
      seq: 99,
      captured_at: "2026-10-13T12:30:00+08:00",
      sent_at: "2026-10-13T12:30:05+08:00",
    });
    expect(await pushBodyContentHash(a)).toBe(await pushBodyContentHash(b));
    expect(stablePushBody(a)).toEqual(stablePushBody(b));
  });

  it("deliverToTarget skips identical body for the same subscriber", async () => {
    const sub = await createSubscriber(env, { url: "https://dedupe.example/hook" });
    const races = [
      race([
        {
          runner_id: "H001",
          horse_no: 1,
          horse_name: "A",
          win_odds: 3.5,
          place_odds: 1.4,
          status: "Declared",
          final_position: null,
        },
      ]),
    ];
    const envelope = buildEnvelope({
      event: "odds_delta",
      meeting_date: "2026-10-14",
      venue: "HV",
      races,
      changes: [change({ runner_id: "H001", new_odds: 3.5 })],
      event_id: "e1",
      seq: 1,
    });
    const body = JSON.stringify(envelope);
    let posts = 0;
    const fetchImpl: typeof fetch = async () => {
      posts++;
      return new Response("{}", { status: 202 });
    };
    const first = await deliverToTarget(
      env,
      envelope,
      body,
      { subscriber_id: sub.id, url: sub.url, secret: null },
      fetchImpl,
    );
    expect(first.success).toBe(true);
    expect(first.skipped_dedupe).toBeFalsy();
    expect(posts).toBe(1);

    const envelope2 = buildEnvelope({
      event: "odds_delta",
      meeting_date: "2026-10-14",
      venue: "HV",
      races,
      changes: [change({ runner_id: "H001", new_odds: 3.5 })],
      event_id: "e2",
      seq: 2,
      captured_at: "2026-10-13T13:00:00+08:00",
    });
    const second = await deliverToTarget(
      env,
      envelope2,
      JSON.stringify(envelope2),
      { subscriber_id: sub.id, url: sub.url, secret: null },
      fetchImpl,
    );
    expect(second.skipped_dedupe).toBe(true);
    expect(posts).toBe(1);
  });
});

describe("odds_update hash across restart", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM worker_meta`).run();
    await env.DB.prepare(`DELETE FROM push_events`).run();
    await env.DB.prepare(`DELETE FROM push_seq`).run();
    await env.DB.prepare(`DELETE FROM push_subscribers`).run();
  });

  it("skips resend when last pushed races hash matches (D1-persisted)", async () => {
    const races = [
      race([
        {
          runner_id: "H001",
          horse_no: 1,
          horse_name: "A",
          win_odds: 3.5,
          place_odds: 1.4,
          status: "Declared",
          final_position: null,
        },
      ]),
    ];
    const hash = await oddsUpdateRacesHash(races);
    await saveLastOddsUpdateHash(env, "2026-10-14", "HV", hash);
    expect(await loadLastOddsUpdateHash(env.DB, "2026-10-14", "HV")).toBe(hash);

    const sent = await emitOddsUpdateIfChanged({
      env,
      meeting_date: "2026-10-14",
      venue: "HV",
      races,
      captured_at: "2026-10-13T12:00:00+08:00",
      sample_interval_s: 3,
      source_last_updated_at: null,
    });
    expect(sent.emitted).toBe(false);
    expect(sent.hash).toBe(hash);

    // Seed last-pushed from races helper
    const seeded = lastPushedFromRaces(races);
    expect(seeded["H001|WIN"]).toBe(3.5);
  });
});

describe("off-window coalesce", () => {
  it("uses PUSH_OFFWINDOW_COALESCE_SEC outside high-freq window", () => {
    const e = {
      PUSH_COALESCE_MS: "2000",
      PUSH_OFFWINDOW_COALESCE_SEC: "300",
    } as unknown as Env;
    expect(resolveCoalesceMs(e, true)).toBe(2000);
    expect(resolveCoalesceMs(e, false)).toBe(
      DEFAULT_PUSH_OFFWINDOW_COALESCE_SEC * 1000,
    );
  });
});
