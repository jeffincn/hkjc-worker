import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { buildRaceOddsSnapshot } from "../src/parse/odds";
import {
  buildPoolInvestments,
  computeOddsDeltaChanges,
} from "../src/push/delta";
import { emitPush, preparePushEvent } from "../src/push/emit";
import { ODDS_BASIS, type PushEnvelope } from "../src/push/envelope";
import {
  isInFastWindow,
  NO_UPDATE_FAST_MS,
  NO_UPDATE_SLOW_MS,
  shouldEmitNoUpdate,
} from "../src/push/heartbeat";
import { getPushEventById, listPushEvents } from "../src/push/ledger";
import { allocatePushSeq, getLastChange } from "../src/push/seq";
import { createSubscriber } from "../src/push/subscribers";
import { flushDueRetries } from "../src/push/pusher";

async function clearPushState(): Promise<void> {
  await env.DB.prepare(`DELETE FROM push_subscribers`).run();
  await env.DB.prepare(`DELETE FROM pending_pushes`).run();
  await env.DB.prepare(`DELETE FROM push_log`).run();
  await env.DB.prepare(`DELETE FROM push_events`).run();
  await env.DB.prepare(`DELETE FROM push_seq`).run();
}

function snap(win: string, pla: string, lastUpdate: string | null = "2026-10-07T18:00:00+08:00") {
  return buildRaceOddsSnapshot({
    race: {
      no: 1,
      postTime: "2026-10-07T18:35:00+08:00",
      runners: [
        { no: 1, name_en: "ALPHA", name_ch: "甲", status: "Declared" },
        { no: 2, name_en: "BETA", name_ch: "乙", status: "Declared" },
      ],
    },
    winPool: {
      oddsType: "WIN",
      sellStatus: "START_SELL",
      lastUpdateTime: lastUpdate,
      oddsNodes: [
        { combString: "01", oddsValue: win },
        { combString: "02", oddsValue: "10" },
      ],
    },
    plaPool: {
      oddsType: "PLA",
      sellStatus: "START_SELL",
      lastUpdateTime: lastUpdate,
      oddsNodes: [
        { combString: "01", oddsValue: pla },
        { combString: "02", oddsValue: "3.0" },
      ],
    },
  });
}

describe("hkjc-push/1.1 seq + ledger + delta + heartbeat + replay", () => {
  beforeEach(async () => {
    await clearPushState();
  });

  it("allocates monotonic seq per meeting_date+venue", async () => {
    const a = await allocatePushSeq(env, "2026-10-07", "HV");
    const b = await allocatePushSeq(env, "2026-10-07", "HV");
    const c = await allocatePushSeq(env, "2026-10-07", "ST");
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(c).toBe(1);
  });

  it("preparePushEvent persists ledger once and marks last_change for odds events", async () => {
    const e1 = await preparePushEvent(env, {
      event: "odds_update",
      meeting_date: "2026-10-07",
      venue: "HV",
      races: [],
      source_last_updated_at: "2026-10-07T18:00:00+08:00",
    });
    expect(e1.schema).toBe("hkjc-push/1.1");
    expect(e1.seq).toBe(1);
    expect(e1.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const e2 = await preparePushEvent(env, {
      event: "odds_delta",
      meeting_date: "2026-10-07",
      venue: "HV",
      races: [],
      changes: [],
      pools: [],
      source_last_updated_at: "2026-10-07T18:00:00+08:00",
    });
    expect(e2.seq).toBe(2);

    const stored = await getPushEventById(env, e1.event_id);
    expect(stored?.event_id).toBe(e1.event_id);
    expect(stored?.seq).toBe(1);

    const last = await getLastChange(env, "2026-10-07", "HV");
    expect(last.last_change_seq).toBe(2);
    expect(last.last_change_at).toBeTruthy();
  });

  it("computes odds_delta with prev null on first observation and prev/new on change", () => {
    const first = snap("4.0", "1.8");
    const names = new Map([
      [1, { horse_name_en: "ALPHA", horse_name_ch: "甲" }],
      [2, { horse_name_en: "BETA", horse_name_ch: "乙" }],
    ]);
    const firstChanges = computeOddsDeltaChanges({
      prev: null,
      next: first,
      horseNames: names,
    });
    expect(firstChanges.length).toBeGreaterThan(0);
    expect(firstChanges.every((c) => c.prev_odds === null)).toBe(true);
    expect(firstChanges.every((c) => c.odds_basis === ODDS_BASIS)).toBe(true);
    const win1 = firstChanges.find((c) => c.runner_no === 1 && c.bet_type === "WIN");
    expect(win1?.new_odds).toBe(4);
    expect(win1?.horse_name_ch).toBe("甲");

    const second = snap("3.5", "1.7");
    const delta = computeOddsDeltaChanges({
      prev: first,
      next: second,
      horseNames: names,
    });
    // Only horse 1 WIN+PLA changed (horse 2 unchanged)
    expect(delta).toHaveLength(2);
    expect(delta.map((c) => c.bet_type).sort()).toEqual(["PLA", "WIN"]);
    expect(delta.find((c) => c.bet_type === "WIN")).toMatchObject({
      prev_odds: 4,
      new_odds: 3.5,
      runner_no: 1,
    });
  });

  it("builds pools investment from poolInvs and null when absent", () => {
    const withInv = buildPoolInvestments(
      [
        {
          oddsType: "WIN",
          leg: { number: 1 },
          investment: 1234567,
        },
        {
          oddsType: "PLA",
          leg: { number: 1 },
          investment: "890",
        },
      ],
      [1],
    );
    expect(withInv).toEqual([
      { race_no: 1, bet_type: "PLA", investment: 890 },
      { race_no: 1, bet_type: "WIN", investment: 1234567 },
    ]);

    const missing = buildPoolInvestments(undefined, [2]);
    expect(missing).toEqual([
      { race_no: 2, bet_type: "PLA", investment: null },
      { race_no: 2, bet_type: "WIN", investment: null },
    ]);
  });

  it("rate-limits no_update heartbeat (60s fast / 5min slow)", () => {
    const now = Date.parse("2026-10-07T18:20:00+08:00");
    expect(isInFastWindow("2026-10-07T18:35:00+08:00", now)).toBe(true);
    expect(isInFastWindow("2026-10-07T22:00:00+08:00", now)).toBe(false);

    expect(
      shouldEmitNoUpdate({ nowMs: now, lastNoUpdateAtMs: null, inFastWindow: true }),
    ).toBe(true);
    expect(
      shouldEmitNoUpdate({
        nowMs: now,
        lastNoUpdateAtMs: now - NO_UPDATE_FAST_MS + 1000,
        inFastWindow: true,
      }),
    ).toBe(false);
    expect(
      shouldEmitNoUpdate({
        nowMs: now,
        lastNoUpdateAtMs: now - NO_UPDATE_FAST_MS,
        inFastWindow: true,
      }),
    ).toBe(true);
    expect(
      shouldEmitNoUpdate({
        nowMs: now,
        lastNoUpdateAtMs: now - NO_UPDATE_SLOW_MS + 1000,
        inFastWindow: false,
      }),
    ).toBe(false);
    expect(
      shouldEmitNoUpdate({
        nowMs: now,
        lastNoUpdateAtMs: now - NO_UPDATE_SLOW_MS,
        inFastWindow: false,
      }),
    ).toBe(true);
  });

  it("replays events via GET /v1/events and GET /v1/events/:id", async () => {
    const e1 = await preparePushEvent(env, {
      event: "odds_update",
      meeting_date: "2026-10-07",
      venue: "HV",
      races: [],
      source_last_updated_at: "2026-10-07T18:00:00+08:00",
    });
    const e2 = await preparePushEvent(env, {
      event: "no_update",
      meeting_date: "2026-10-07",
      venue: "HV",
      races: [],
      source_last_updated_at: null,
      last_change_seq: e1.seq,
      last_change_at: e1.captured_at,
    });
    expect(e2.quality.missing_source_time).toBe(true);

    const listed = await listPushEvents(env, {
      meeting_date: "2026-10-07",
      venue: "HV",
      since_seq: 0,
      limit: 10,
    });
    expect(listed.map((e) => e.seq)).toEqual([1, 2]);

    const since = await listPushEvents(env, {
      meeting_date: "2026-10-07",
      venue: "HV",
      since_seq: 1,
      limit: 10,
    });
    expect(since).toHaveLength(1);
    expect(since[0].event_id).toBe(e2.event_id);

    const ctx = createExecutionContext();
    const listReq = new Request(
      `https://example.com/v1/events?meeting_date=2026-10-07&venue=HV&since_seq=1`,
      { headers: { Authorization: "Bearer test-api-token" } },
    );
    const listRes = await worker.fetch(listReq, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { events: PushEnvelope[] };
    expect(listBody.events).toHaveLength(1);
    expect(listBody.events[0].event).toBe("no_update");

    const getCtx = createExecutionContext();
    const getReq = new Request(`https://example.com/v1/events/${e1.event_id}`, {
      headers: { Authorization: "Bearer test-api-token" },
    });
    const getRes = await worker.fetch(getReq, env, getCtx);
    await waitOnExecutionContext(getCtx);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { event: PushEnvelope };
    expect(getBody.event.event_id).toBe(e1.event_id);
  });

  it("retries resend the same event_id/seq/body from push_events", async () => {
    await createSubscriber(env, {
      url: "https://retry-target.example/hook",
      secret: null,
    });

    let attempts = 0;
    let firstBody = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      attempts++;
      const body = String(init?.body ?? "");
      if (attempts === 1) {
        firstBody = body;
        return new Response("fail", { status: 500 });
      }
      expect(body).toBe(firstBody);
      const parsed = JSON.parse(body) as PushEnvelope;
      expect(parsed.event_id).toBeTruthy();
      expect(parsed.seq).toBe(1);
      return new Response("{}", { status: 202 });
    };

    const { envelope } = await emitPush(
      env,
      {
        event: "test",
        meeting_date: "2026-10-07",
        venue: "HV",
        races: [],
        source_last_updated_at: null,
      },
      { fetchImpl, force: true },
    );

    expect(attempts).toBe(1);
    const pending = await env.DB.prepare(
      `SELECT event_id, payload_json FROM pending_pushes`,
    ).all<{ event_id: string; payload_json: string }>();
    expect(pending.results).toHaveLength(1);
    expect(pending.results![0].event_id).toBe(envelope.event_id);

    // Force due
    await env.DB.prepare(
      `UPDATE pending_pushes SET next_retry_at = ?`,
    )
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();

    await flushDueRetries(env, { fetchImpl });
    expect(attempts).toBe(2);

    const fromLedger = await getPushEventById(env, envelope.event_id);
    expect(JSON.stringify(fromLedger)).toBe(firstBody);
  });
});
