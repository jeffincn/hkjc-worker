import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "../src/push/envelope";
import { sendPush } from "../src/push/pusher";
import {
  createSubscriber,
  getSubscriber,
  updateSubscriber,
} from "../src/push/subscribers";
import {
  DEFAULT_SUBSCRIBER_WINDOW_BEFORE_SEC,
  gateSubscriberDelivery,
  hasSentWindowOpenSnapshot,
  isInSubscriberRaceDayWindow,
  loadMeetingWindowContext,
  maybeDeliverWindowOpenSnapshot,
} from "../src/push/subscriber-window";

const MEETING = "2026-10-14";
const VENUE = "HV";
/** First post 20:00 HKT = 12:00 UTC. */
const FIRST_POST = "2026-10-14T20:00:00+08:00";
const FIRST_POST_MS = Date.parse(FIRST_POST);

async function seedMeeting(): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO meetings (meeting_date, venue, total_races, status, data_source, updated_at)
     VALUES (?, ?, 2, 'OPEN', 'graphql', ?)`,
  )
    .bind(MEETING, VENUE, new Date().toISOString())
    .run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO races
      (meeting_date, venue, race_no, post_time, status, data_source, updated_at)
     VALUES (?, ?, 1, ?, 'DEFINED', 'graphql', ?)`,
  )
    .bind(MEETING, VENUE, FIRST_POST, new Date().toISOString())
    .run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO races
      (meeting_date, venue, race_no, post_time, status, data_source, updated_at)
     VALUES (?, ?, 2, ?, 'DEFINED', 'graphql', ?)`,
  )
    .bind(MEETING, VENUE, "2026-10-14T20:30:00+08:00", new Date().toISOString())
    .run();
}

describe("subscriber raceday window helpers", () => {
  it("defaults window_before_sec to 10800 (3h)", () => {
    expect(DEFAULT_SUBSCRIBER_WINDOW_BEFORE_SEC).toBe(10_800);
  });

  it("opens 3h before first post and closes on final dividends", () => {
    const before = 10_800;
    expect(
      isInSubscriberRaceDayWindow({
        nowMs: FIRST_POST_MS - before * 1000 - 1,
        firstPostMs: FIRST_POST_MS,
        finalDividendsPublished: false,
        windowBeforeSec: before,
      }),
    ).toBe(false);
    expect(
      isInSubscriberRaceDayWindow({
        nowMs: FIRST_POST_MS - before * 1000,
        firstPostMs: FIRST_POST_MS,
        finalDividendsPublished: false,
        windowBeforeSec: before,
      }),
    ).toBe(true);
    expect(
      isInSubscriberRaceDayWindow({
        nowMs: FIRST_POST_MS + 3600_000,
        firstPostMs: FIRST_POST_MS,
        finalDividendsPublished: true,
        windowBeforeSec: before,
      }),
    ).toBe(false);
  });
});

describe("gateSubscriberDelivery + fan-out", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM push_subscribers`).run();
    await env.DB.prepare(`DELETE FROM pending_pushes`).run();
    await env.DB.prepare(`DELETE FROM push_log`).run();
    await env.DB.prepare(`DELETE FROM push_events`).run();
    await env.DB.prepare(`DELETE FROM push_seq`).run();
    await env.DB.prepare(`DELETE FROM worker_meta`).run();
    await env.DB.prepare(`DELETE FROM races`).run();
    await env.DB.prepare(`DELETE FROM meetings`).run();
    await env.DB.prepare(`DELETE FROM odds_snapshots`).run();
    await seedMeeting();
  });

  it("CRUD exposes active_window / window_before_sec", async () => {
    const created = await createSubscriber(env, {
      url: "https://manus-test.example/hook",
      active_window: "raceday",
      window_before_sec: 10800,
    });
    expect(created.active_window).toBe("raceday");
    expect(created.window_before_sec).toBe(10800);

    const patched = await updateSubscriber(env, created.id, {
      active_window: "always",
    });
    expect(patched?.active_window).toBe("always");
    const back = await updateSubscriber(env, created.id, {
      active_window: "raceday",
      window_before_sec: 7200,
    });
    expect(back?.window_before_sec).toBe(7200);

    await expect(
      updateSubscriber(env, created.id, { active_window: "nope" as "always" }),
    ).rejects.toThrow(/active_window/);
  });

  it("raceday subscriber skipped outside window; always subscriber receives", async () => {
    const always = await createSubscriber(env, {
      url: "https://always.example/hook",
      active_window: "always",
    });
    const raceday = await createSubscriber(env, {
      url: "https://raceday.example/hook",
      active_window: "raceday",
      window_before_sec: 10800,
    });

    // 4h before first post — outside Manus window.
    const nowMs = FIRST_POST_MS - 4 * 3600_000;
    const envelope = buildEnvelope({
      event: "odds_delta",
      meeting_date: MEETING,
      venue: VENUE,
      races: [],
      changes: [],
      event_id: "win-1",
      seq: 1,
    });

    const gateAlways = await gateSubscriberDelivery(env, always, envelope, nowMs);
    const gateRace = await gateSubscriberDelivery(env, raceday, envelope, nowMs);
    expect(gateAlways.allowed).toBe(true);
    expect(gateRace.allowed).toBe(false);

    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response("{}", { status: 202 });
    };

    // Monkey-patch Date.now for sendPush path via gate using real now —
    // exercise enqueue via sendPush won't use our nowMs. Call gate-filtered
    // send by temporarily setting system... Instead assert gate + manual filter.
    expect(gateRace.reason).toMatch(/outside/i);

    // Inside window (2h before post).
    const inMs = FIRST_POST_MS - 2 * 3600_000;
    expect(
      (await gateSubscriberDelivery(env, raceday, envelope, inMs)).allowed,
    ).toBe(true);

    // Fan-out with real clock: patch by delivering only when allowed.
    // Use sendPush at "now" — seed post far in future so window includes Date.now().
    await env.DB.prepare(
      `UPDATE races SET post_time=? WHERE meeting_date=? AND venue=? AND race_no=1`,
    )
      .bind(
        new Date(Date.now() + 2 * 3600_000).toISOString(),
        MEETING,
        VENUE,
      )
      .run();

    const live = buildEnvelope({
      event: "odds_update",
      meeting_date: MEETING,
      venue: VENUE,
      races: [
        {
          race_no: 1,
          post_time: FIRST_POST,
          snapshot_time: "2026-10-14T18:00:00+08:00",
          pool_status: "START_SELL",
          runners: [],
        },
      ],
      event_id: "live-1",
      seq: 2,
    });
    await sendPush(env, live, { fetchImpl, force: true, forceDirect: true });
    expect(urls).toContain("https://always.example/hook");
    expect(urls).toContain("https://raceday.example/hook");
    expect(await getSubscriber(env, raceday.id)).toBeTruthy();
  });

  it("outside window: nothing queued (skipped_window, no pending)", async () => {
    await createSubscriber(env, {
      url: "https://raceday-only.example/hook",
      active_window: "raceday",
      window_before_sec: 10800,
    });
    // First post far in the future → still outside 3h window.
    await env.DB.prepare(
      `UPDATE races SET post_time=? WHERE meeting_date=? AND venue=? AND race_no=1`,
    )
      .bind(
        new Date(Date.now() + 10 * 3600_000).toISOString(),
        MEETING,
        VENUE,
      )
      .run();

    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response("{}", { status: 202 });
    };

    const result = await sendPush(
      env,
      buildEnvelope({
        event: "no_update",
        meeting_date: MEETING,
        venue: VENUE,
        races: [],
        event_id: "hb-1",
        seq: 1,
      }),
      { fetchImpl, force: true, forceDirect: true },
    );
    expect(urls).toHaveLength(0);
    expect(result.deliveries?.[0]?.skipped_window).toBe(true);
    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pending_pushes`,
    ).first<{ n: number }>();
    expect(Number(pending?.n ?? 0)).toBe(0);
  });

  it("on window open sends one full odds_update snapshot first", async () => {
    const sub = await createSubscriber(env, {
      url: "https://snap.example/hook",
      active_window: "raceday",
      window_before_sec: 10800,
    });
    // Put first post 1h ahead so we are inside the 3h window.
    await env.DB.prepare(
      `UPDATE races SET post_time=? WHERE meeting_date=? AND venue=? AND race_no=1`,
    )
      .bind(
        new Date(Date.now() + 3600_000).toISOString(),
        MEETING,
        VENUE,
      )
      .run();

    // Seed an odds snapshot so complete races[] is non-empty.
    await env.DB.prepare(
      `INSERT INTO odds_snapshots
        (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at)
       VALUES (?, ?, 1, ?, 'hash1', 'START_SELL', ?, 'graphql', ?)`,
    )
      .bind(
        MEETING,
        VENUE,
        "2026-10-14T18:00:00+08:00",
        JSON.stringify({
          race_no: 1,
          post_time: FIRST_POST,
          snapshot_time: "2026-10-14T18:00:00+08:00",
          pool_status: "START_SELL",
          runners: [
            {
              runner_id: "H001",
              horse_no: 1,
              horse_name: "A",
              win_odds: 3.5,
              place_odds: 1.4,
              status: "Declared",
              final_position: null,
            },
          ],
          payload: { race_no: 1, pool_status: "START_SELL", win: {}, pla: {}, last_update: null },
        }),
        new Date().toISOString(),
      )
      .run();

    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("{}", { status: 202 });
    };

    expect(await hasSentWindowOpenSnapshot(env.DB, sub.id, MEETING, VENUE)).toBe(
      false,
    );

    await maybeDeliverWindowOpenSnapshot({
      env,
      subscriber: sub,
      target: { subscriber_id: sub.id, url: sub.url, secret: null },
      meeting_date: MEETING,
      venue: VENUE,
      fetchImpl,
    });

    expect(bodies).toHaveLength(1);
    const snap = JSON.parse(bodies[0]!) as {
      event: string;
      meta?: { window_open_snapshot?: boolean };
      races: unknown[];
    };
    expect(snap.event).toBe("odds_update");
    expect(snap.meta?.window_open_snapshot).toBe(true);
    expect(snap.races.length).toBeGreaterThan(0);
    expect(await hasSentWindowOpenSnapshot(env.DB, sub.id, MEETING, VENUE)).toBe(
      true,
    );

    // Second call is a no-op.
    await maybeDeliverWindowOpenSnapshot({
      env,
      subscriber: sub,
      target: { subscriber_id: sub.id, url: sub.url, secret: null },
      meeting_date: MEETING,
      venue: VENUE,
      fetchImpl,
    });
    expect(bodies).toHaveLength(1);
  });

  it("loadMeetingWindowContext reads first post from D1", async () => {
    const ctx = await loadMeetingWindowContext(env.DB, MEETING, VENUE);
    expect(ctx.firstPostMs).toBe(FIRST_POST_MS);
    expect(ctx.expectedRaceNos).toEqual([1, 2]);
    expect(ctx.finalDividendsPublished).toBe(false);
  });

  it("migration default columns: new subscriber is always/10800", async () => {
    const row = await createSubscriber(env, { url: "https://default.example/hook" });
    expect(row.active_window).toBe("always");
    expect(row.window_before_sec).toBe(10800);
  });
});
