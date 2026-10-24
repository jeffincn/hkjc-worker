import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  clampMaxBytes,
  packItemsUnderBudget,
  QUERY_MAX_BYTES_CAP,
  QUERY_MAX_BYTES_DEFAULT,
} from "../src/api/byte-page";
import {
  clampOddsSnapshotsLimit,
  ODDS_SNAPSHOTS_DEFAULT_LIMIT,
  ODDS_SNAPSHOTS_MAX_LIMIT,
} from "../src/api/odds-query";
import { emitIdleKeepalive } from "../src/push/odds-emit";
import { preparePushEvent } from "../src/push/emit";
import { recordPollTicks } from "../src/store/poll-ticks";

const READ = { Authorization: "Bearer test-read-token" };
const WRITE = { Authorization: "Bearer test-api-token" };

async function clear(): Promise<void> {
  for (const t of [
    "poll_ticks",
    "odds_snapshots",
    "runners",
    "races",
    "meetings",
    "push_events",
    "push_seq",
    "worker_meta",
    "pending_pushes",
    "push_log",
  ]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

async function seedSnap(args: {
  date: string;
  venue: string;
  race_no: number;
  hash: string;
  snapshot_time: string;
  created_at: string;
  win_odds?: number;
}): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO meetings (meeting_date, venue, total_races, status, data_source, updated_at)
     VALUES (?, ?, 1, 'DEFINED', 'graphql', ?)
     ON CONFLICT(meeting_date, venue) DO NOTHING`,
  )
    .bind(args.date, args.venue, args.created_at)
    .run();
  await env.DB.prepare(
    `INSERT INTO races (meeting_date, venue, race_no, post_time, status, data_source, updated_at)
     VALUES (?, ?, ?, NULL, 'DEFINED', 'graphql', ?)
     ON CONFLICT(meeting_date, venue, race_no) DO NOTHING`,
  )
    .bind(args.date, args.venue, args.race_no, args.created_at)
    .run();
  const raw = {
    race_no: args.race_no,
    snapshot_time: args.snapshot_time,
    pool_status: "START_SELL",
    runners: [
      {
        runner_id: "H001",
        horse_no: 1,
        horse_code: "H001",
        horse_name: "ALPHA",
        win_odds: args.win_odds ?? 5,
        place_odds: 2,
        status: "Declared",
        raw_status: "Declared",
        final_position: null,
      },
    ],
    payload: {
      race_no: args.race_no,
      pool_status: "START_SELL",
      win: { "1": args.win_odds ?? 5 },
      pla: { "1": 2 },
      last_update: args.snapshot_time,
    },
  };
  const result = await env.DB.prepare(
    `INSERT INTO odds_snapshots
      (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at, sample_interval_s)
     VALUES (?, ?, ?, ?, ?, 'START_SELL', ?, 'graphql', ?, 3)
     RETURNING id`,
  )
    .bind(
      args.date,
      args.venue,
      args.race_no,
      args.snapshot_time,
      args.hash,
      JSON.stringify(raw),
      args.created_at,
    )
    .first<{ id: number }>();
  return result!.id;
}

describe("byte-page helpers (A2)", () => {
  it("clamps max_bytes default and cap to 1_200_000", () => {
    expect(clampMaxBytes(null)).toBe(QUERY_MAX_BYTES_DEFAULT);
    expect(clampMaxBytes(undefined)).toBe(1_200_000);
    expect(clampMaxBytes(999_999_999)).toBe(QUERY_MAX_BYTES_CAP);
    expect(clampMaxBytes(0)).toBe(1);
    expect(clampMaxBytes(1000)).toBe(1000);
  });

  it("clamps odds snapshots limit", () => {
    expect(clampOddsSnapshotsLimit(null)).toBe(ODDS_SNAPSHOTS_DEFAULT_LIMIT);
    expect(clampOddsSnapshotsLimit(0)).toBe(1);
    expect(clampOddsSnapshotsLimit(9999)).toBe(ODDS_SNAPSHOTS_MAX_LIMIT);
    expect(clampOddsSnapshotsLimit(10)).toBe(10);
  });

  it("packItemsUnderBudget stops before exceeding maxBytes (keeps ≥1)", () => {
    const items = [
      { id: 1, blob: "x".repeat(100) },
      { id: 2, blob: "y".repeat(100) },
      { id: 3, blob: "z".repeat(100) },
    ];
    const packed = packItemsUnderBudget({
      items,
      maxBytes: 250,
      envelopeOverheadBytes: 10,
      encodeOne: (i) => JSON.stringify(i),
    });
    expect(packed.items.length).toBeGreaterThanOrEqual(1);
    expect(packed.items.length).toBeLessThan(items.length);
    expect(packed.truncated_by_bytes).toBe(true);
  });

  it("packItemsUnderBudget meters uncompressed UTF-8 bytes (not .length)", () => {
    // Each item JSON is mostly CJK: 40 chars × 3 UTF-8 bytes ≫ 40 code units.
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      name: "馬".repeat(40),
    }));
    const packed = packItemsUnderBudget({
      items,
      maxBytes: 200,
      envelopeOverheadBytes: 20,
      encodeOne: (i) => JSON.stringify(i),
    });
    expect(packed.truncated_by_bytes).toBe(true);
    expect(packed.items.length).toBeGreaterThanOrEqual(1);
    expect(packed.items.length).toBeLessThan(items.length);
  });
});

describe("GET /v1/odds/snapshots (issue #38 P1 R5)", () => {
  const date = "2026-10-25";
  const venue = "ST";
  const race_no = 3;

  beforeEach(async () => {
    await clear();
  });

  it("rejects READ path without bearer; accepts READ_API_TOKEN", async () => {
    const ctx0 = createExecutionContext();
    const res0 = await worker.fetch(
      new Request(
        `http://localhost/v1/odds/snapshots?date=${date}&venue=${venue}&race_no=${race_no}`,
      ),
      env,
      ctx0,
    );
    await waitOnExecutionContext(ctx0);
    expect(res0.status).toBe(401);

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(
        `http://localhost/v1/odds/snapshots?date=${date}&venue=${venue}&race_no=${race_no}`,
        { headers: READ },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });

  it("filters by persisted created_at (as_of), not source snapshot_time — no future leak", async () => {
    // Row A: early source time, but persisted AFTER as_of → must NOT appear
    // Row B: late source time, persisted BEFORE as_of → must appear
    const asOf = "2026-10-25T06:00:00.000Z";
    await seedSnap({
      date,
      venue,
      race_no,
      hash: "late-persist",
      snapshot_time: "2026-10-25T05:00:00+08:00", // source earlier
      created_at: "2026-10-25T06:30:00.000Z", // persisted after as_of
      win_odds: 9,
    });
    const idB = await seedSnap({
      date,
      venue,
      race_no,
      hash: "early-persist",
      snapshot_time: "2026-10-25T14:00:00+08:00", // source later than as_of wall
      created_at: "2026-10-25T05:55:00.000Z", // persisted before as_of
      win_odds: 4,
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(
        `http://localhost/v1/odds/snapshots?date=${date}&venue=${venue}&race_no=${race_no}&as_of=${encodeURIComponent(asOf)}`,
        { headers: READ },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      persisted_time_field: string;
      as_of: string;
      snapshots: Array<{ id: number; created_at: string; data: { runners: Array<{ win_odds: number }> } }>;
      has_more: boolean;
    };
    expect(body.persisted_time_field).toBe("created_at");
    expect(body.as_of).toBe(new Date(asOf).toISOString());
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]!.id).toBe(idB);
    expect(body.snapshots[0]!.data.runners[0]!.win_odds).toBe(4);
    expect(body.has_more).toBe(false);
  });

  it("paginates with since_id cursor like /v1/events since_seq", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedSnap({
          date,
          venue,
          race_no,
          hash: `h${i}`,
          snapshot_time: `2026-10-25T12:0${i}:00+08:00`,
          created_at: `2026-10-25T04:0${i}:00.000Z`,
          win_odds: 3 + i,
        }),
      );
    }

    const ctx1 = createExecutionContext();
    const res1 = await worker.fetch(
      new Request(
        `http://localhost/v1/odds/snapshots?date=${date}&venue=${venue}&race_no=${race_no}&since_id=0&limit=2`,
        { headers: READ },
      ),
      env,
      ctx1,
    );
    await waitOnExecutionContext(ctx1);
    const page1 = (await res1.json()) as {
      snapshots: Array<{ id: number }>;
      next_since_id: number;
      has_more: boolean;
    };
    expect(page1.snapshots.map((s) => s.id)).toEqual([ids[0], ids[1]]);
    expect(page1.has_more).toBe(true);
    expect(page1.next_since_id).toBe(ids[1]);

    const ctx2 = createExecutionContext();
    const res2 = await worker.fetch(
      new Request(
        `http://localhost/v1/odds/snapshots?date=${date}&venue=${venue}&race_no=${race_no}&since_id=${page1.next_since_id}&limit=2`,
        { headers: READ },
      ),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    const page2 = (await res2.json()) as {
      snapshots: Array<{ id: number }>;
      has_more: boolean;
      next_since_id: number;
    };
    expect(page2.snapshots.map((s) => s.id)).toEqual([ids[2], ids[3]]);
    expect(page2.has_more).toBe(true);

    const ctx3 = createExecutionContext();
    const res3 = await worker.fetch(
      new Request(
        `http://localhost/v1/odds/snapshots?date=${date}&venue=${venue}&race_no=${race_no}&since_id=${page2.next_since_id}&limit=2`,
        { headers: READ },
      ),
      env,
      ctx3,
    );
    await waitOnExecutionContext(ctx3);
    const page3 = (await res3.json()) as {
      snapshots: Array<{ id: number }>;
      has_more: boolean;
    };
    expect(page3.snapshots.map((s) => s.id)).toEqual([ids[4]]);
    expect(page3.has_more).toBe(false);
  });

  it("respects max_bytes on /v1/odds/snapshots (same 1.2MB A2 budget)", async () => {
    for (let i = 0; i < 4; i++) {
      await seedSnap({
        date,
        venue,
        race_no,
        hash: `fat-${i}`,
        snapshot_time: `2026-10-25T12:0${i}:00+08:00`,
        created_at: `2026-10-25T04:0${i}:00.000Z`,
        win_odds: 3 + i,
      });
    }
    // Inflate raw_json via large horse names in subsequent inserts is heavy;
    // use tiny max_bytes so pack truncates.
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(
        `http://localhost/v1/odds/snapshots?date=${date}&venue=${venue}&race_no=${race_no}&limit=50&max_bytes=400`,
        { headers: READ },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      max_bytes: number;
      snapshots: unknown[];
      truncated_by_bytes: boolean;
      has_more: boolean;
      next_since_id: number | null;
    };
    expect(body.max_bytes).toBe(400);
    expect(body.snapshots.length).toBeGreaterThanOrEqual(1);
    expect(body.truncated_by_bytes).toBe(true);
    expect(body.has_more).toBe(true);
    expect(body.next_since_id).not.toBeNull();
  });

  it("leaves /v1/odds/history from/to semantics unchanged (coverage only)", async () => {
    await seedSnap({
      date,
      venue,
      race_no,
      hash: "h1",
      snapshot_time: "2026-10-25T12:00:00+08:00",
      created_at: "2026-10-25T04:00:00.000Z",
    });
    await seedSnap({
      date,
      venue,
      race_no,
      hash: "h2",
      snapshot_time: "2026-10-25T12:05:00+08:00",
      created_at: "2026-10-25T04:05:00.000Z",
    });
    await recordPollTicks(env, date, venue, [
      { race_no, changed: true, tick_time: "2026-10-25T04:00:00.000Z" },
      { race_no, changed: false, tick_time: "2026-10-25T04:01:00.000Z" },
    ]);

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(
        `http://localhost/v1/odds/history?date=${date}&venue=${venue}&race_no=${race_no}` +
          `&from=2026-10-25T04:00:00.000Z&to=2026-10-25T04:02:00.000Z`,
        { headers: WRITE },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      snapshots: unknown[];
      coverage: { range: { kind: string } | null; tick_count: number };
    };
    // history still returns ALL content-change snapshots for the race
    expect(body.snapshots.length).toBe(2);
    expect(body.coverage.range?.kind).toBe("STATIC");
    expect(body.coverage.tick_count).toBe(2);
  });
});

describe("GET /v1/events max_bytes truncation (issue #38 A2)", () => {
  beforeEach(async () => {
    await clear();
  });

  it("stops early under max_bytes, returns ≥1 event, next_since_seq advances", async () => {
    const date = "2026-10-21";
    const venue = "HV";
    // Fat payloads so a tiny max_bytes truncates after 1–2 events.
    const fat = { pad: "p".repeat(800) };
    for (let i = 0; i < 5; i++) {
      await preparePushEvent(env, {
        event: "odds_update",
        meeting_date: date,
        venue,
        races: [],
        source_last_updated_at: null,
        meta: { ...fat, i },
      });
    }

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(
        `http://localhost/v1/events?meeting_date=${date}&venue=${venue}&since_seq=0&limit=500&max_bytes=1200`,
        { headers: READ },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      max_bytes: number;
      events: Array<{ seq: number; event: string; schema: string; meta?: unknown }>;
      next_since_seq: number | null;
      truncated_by_bytes: boolean;
      has_more: boolean;
    };
    expect(body.max_bytes).toBe(1200);
    expect(body.events.length).toBeGreaterThanOrEqual(1);
    expect(body.events.length).toBeLessThan(5);
    expect(body.truncated_by_bytes).toBe(true);
    expect(body.has_more).toBe(true);
    expect(body.next_since_seq).toBe(body.events[body.events.length - 1]!.seq);
    // Event body / seq semantics unchanged
    expect(body.events[0]!.schema).toBe("hkjc-push/1.1");
    expect(body.events[0]!.event).toBe("odds_update");

    const wire = JSON.stringify(body);
    expect(wire.length).toBeLessThanOrEqual(1200 + 400); // small slack for envelope keys

    // Next page continues after next_since_seq
    const ctx2 = createExecutionContext();
    const res2 = await worker.fetch(
      new Request(
        `http://localhost/v1/events?meeting_date=${date}&venue=${venue}&since_seq=${body.next_since_seq}&limit=500&max_bytes=1200`,
        { headers: READ },
      ),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    const page2 = (await res2.json()) as {
      events: Array<{ seq: number }>;
    };
    expect(page2.events[0]!.seq).toBeGreaterThan(body.next_since_seq!);
  });

  it("defaults max_bytes to 1_200_000 and caps higher values", async () => {
    const date = "2026-10-21";
    const venue = "ST";
    await preparePushEvent(env, {
      event: "no_update",
      meeting_date: date,
      venue,
      races: [],
      source_last_updated_at: null,
      last_change_seq: null,
      last_change_at: null,
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(
        `http://localhost/v1/events?meeting_date=${date}&venue=${venue}&max_bytes=99999999`,
        { headers: READ },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as { max_bytes: number; truncated_by_bytes: boolean };
    expect(body.max_bytes).toBe(1_200_000);
    expect(body.truncated_by_bytes).toBe(false);
  });
});

describe("no_update meta.last_successful_poll_at (issue #38 R4)", () => {
  beforeEach(async () => {
    await clear();
  });

  it("adds last_successful_poll_at on no_update without changing envelope fields", async () => {
    const date = "2026-10-25";
    const venue = "HV";
    await recordPollTicks(env, date, venue, [
      { race_no: 1, changed: false, tick_time: "2026-10-25T05:00:00.000Z" },
      { race_no: 2, changed: true, tick_time: "2026-10-25T05:01:30.000Z" },
    ]);

    const out = await emitIdleKeepalive({
      env,
      nowMs: Date.parse("2026-10-25T05:10:00.000Z"),
      lastAnyPushAtMs: Date.parse("2026-10-25T04:00:00.000Z"),
      lastFullByRace: {},
      meeting_date: date,
      venue,
      captured_at: "2026-10-25T13:10:00+08:00",
      sample_interval_s: 3,
      source_last_updated_at: null,
      latestRaces: [],
      // Empty races → heartbeat-only no_update (no odds_update merge).
      expectedRaceNos: [],
      inHighFreqWindow: true,
      lastOddsUpdateHash: null,
    });
    expect(out.emitted).toBe("no_update");

    const row = await env.DB.prepare(
      `SELECT payload_json FROM push_events
       WHERE meeting_date=? AND venue=? AND event_type='no_update'
       ORDER BY seq DESC LIMIT 1`,
    )
      .bind(date, venue)
      .first<{ payload_json: string }>();
    expect(row).toBeTruthy();
    const envl = JSON.parse(row!.payload_json) as {
      schema: string;
      event: string;
      last_change_seq: number | null;
      meta: {
        last_successful_poll_at: string | null;
        heartbeat_interval_sec: number;
      };
    };
    expect(envl.schema).toBe("hkjc-push/1.1");
    expect(envl.event).toBe("no_update");
    expect(envl.meta.last_successful_poll_at).toBe("2026-10-25T05:01:30.000Z");
    expect(envl.meta.heartbeat_interval_sec).toBeGreaterThan(0);
  });
});
