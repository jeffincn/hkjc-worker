import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { buildRaceObservation } from "../src/api/observation";
import { recordPollTicks } from "../src/store/poll-ticks";
import caseA from "./fixtures/observation-case-a.json";
import caseB from "./fixtures/observation-case-b.json";

const WRITE = { Authorization: "Bearer test-api-token" };
const READ = { Authorization: "Bearer test-read-token" };
const READ2 = { Authorization: "Bearer test-read-token-2" };

async function clear(): Promise<void> {
  for (const t of [
    "poll_ticks",
    "odds_snapshots",
    "runners",
    "races",
    "meetings",
    "worker_meta",
  ]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

async function seedSnapshot(args: {
  date: string;
  venue: string;
  race_no: number;
  snapshot: unknown;
  created_at?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO meetings (meeting_date, venue, total_races, status, data_source, updated_at)
     VALUES (?, ?, 1, 'DEFINED', 'graphql', ?)
     ON CONFLICT(meeting_date, venue) DO NOTHING`,
  )
    .bind(args.date, args.venue, new Date().toISOString())
    .run();
  await env.DB.prepare(
    `INSERT INTO races (meeting_date, venue, race_no, post_time, status, data_source, updated_at)
     VALUES (?, ?, ?, NULL, 'DEFINED', 'graphql', ?)
     ON CONFLICT(meeting_date, venue, race_no) DO NOTHING`,
  )
    .bind(args.date, args.venue, args.race_no, new Date().toISOString())
    .run();
  const snap = args.snapshot as { snapshot_time: string; pool_status: string | null };
  await env.DB.prepare(
    `INSERT INTO odds_snapshots
      (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at, sample_interval_s)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'graphql', ?, 3)`,
  )
    .bind(
      args.date,
      args.venue,
      args.race_no,
      snap.snapshot_time,
      `hash-${args.race_no}`,
      snap.pool_status,
      JSON.stringify(args.snapshot),
      args.created_at ?? new Date().toISOString(),
    )
    .run();
}

describe("READ_API_TOKEN (issue #38)", () => {
  beforeEach(async () => {
    await clear();
  });

  it("allows GET /v1/meetings with READ_API_TOKEN", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/v1/meetings", { headers: READ }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });

  it("allows second comma-separated READ_API_TOKEN", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/v1/meetings", { headers: READ2 }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });

  it("rejects READ_API_TOKEN on admin write endpoints", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/v1/admin/test-push", {
        method: "POST",
        headers: READ,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("rejects READ_API_TOKEN on subscriber admin GET", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/v1/admin/subscribers", { headers: READ }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("still allows API_TOKEN on admin write", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/v1/admin/subscribers", { headers: WRITE }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });
});

describe("observation clocks — acceptance A/B (issue #38)", () => {
  beforeEach(async () => {
    await clear();
  });

  it("case A: price static 5 min but polls succeed → last_successful_poll_at advances", async () => {
    const fx = caseA;
    await recordPollTicks(
      env,
      fx.meeting_date,
      fx.venue,
      fx.poll_ticks.map((t) => ({
        race_no: fx.race_no,
        changed: t.changed === 1,
        tick_time: t.tick_time,
      })),
    );
    await seedSnapshot({
      date: fx.meeting_date,
      venue: fx.venue,
      race_no: fx.race_no,
      snapshot: fx.snapshot,
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(
        `http://localhost/v1/odds/latest?date=${fx.meeting_date}&venue=${fx.venue}&race_no=${fx.race_no}`,
        { headers: READ },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      snapshot: { data: { runners: Array<{ win_odds: number }> } } | null;
      observation: {
        last_successful_poll_at: string;
        last_content_change_at: string;
        returned_at: string;
        sample_interval_s: number;
        pools: {
          WIN: {
            last_successful_poll_at: string;
            source_updated_at: string | null;
            sell_status: string | null;
          };
          PLA: {
            last_successful_poll_at: string;
            source_updated_at: string | null;
          };
        };
      };
    };

    expect(body.snapshot).not.toBeNull();
    expect(body.snapshot!.data.runners[0]!.win_odds).toBe(4.5);
    // Still successfully observing — not stale just because price was flat.
    expect(body.observation.last_successful_poll_at).toBe(
      fx.expect.last_successful_poll_at,
    );
    expect(body.observation.last_content_change_at).toBe(
      fx.expect.last_content_change_at,
    );
    expect(
      Date.parse(body.observation.last_successful_poll_at) -
        Date.parse(body.observation.last_content_change_at),
    ).toBe(fx.expect.price_unchanged_for_ms);
    expect(body.observation.pools.WIN.last_successful_poll_at).toBe(
      fx.expect.last_successful_poll_at,
    );
    expect(body.observation.pools.WIN.sell_status).toBe("START_SELL");
    expect(body.observation.pools.WIN.source_updated_at).toBe(
      "2026-10-25T13:00:00+08:00",
    );
    expect(body.observation.returned_at).toBeTruthy();
    expect(body.observation.sample_interval_s).toBe(3);
  });

  it("case B: 45s since last poll → observation age visible; PLA source null kept", async () => {
    const fx = caseB;
    await recordPollTicks(
      env,
      fx.meeting_date,
      fx.venue,
      fx.poll_ticks.map((t) => ({
        race_no: fx.race_no,
        changed: t.changed === 1,
        tick_time: t.tick_time,
      })),
    );
    await seedSnapshot({
      date: fx.meeting_date,
      venue: fx.venue,
      race_no: fx.race_no,
      snapshot: fx.snapshot,
    });

    const obs = buildRaceObservation({
      env,
      poll: {
        last_successful_poll_at: fx.expect.last_successful_poll_at,
        last_content_change_at: fx.poll_ticks[0]!.tick_time,
      },
      snapshot: fx.snapshot as never,
      returned_at: fx.now,
      sample_interval_s: 3,
    });
    const ageMs =
      Date.parse(fx.now) - Date.parse(obs.last_successful_poll_at!);
    expect(ageMs).toBe(fx.expect.observation_age_ms_at_now);
    expect(ageMs).toBeGreaterThan(30_000);
    expect(obs.pools.PLA.source_updated_at).toBe(fx.expect.pla_source_updated_at);

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(
        `http://localhost/v1/odds/latest?date=${fx.meeting_date}&venue=${fx.venue}&race_no=${fx.race_no}`,
        { headers: READ },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      snapshot: unknown;
      observation: {
        last_successful_poll_at: string;
        pools: { PLA: { source_updated_at: string | null } };
      };
    };
    expect(body.snapshot).not.toBeNull();
    expect(body.observation.last_successful_poll_at).toBe(
      fx.expect.last_successful_poll_at,
    );
    expect(body.observation.pools.PLA.source_updated_at).toBeNull();
  });

  it("adds observation on /v1/races without removing existing fields", async () => {
    const fx = caseA;
    await recordPollTicks(
      env,
      fx.meeting_date,
      fx.venue,
      fx.poll_ticks.map((t) => ({
        race_no: fx.race_no,
        changed: t.changed === 1,
        tick_time: t.tick_time,
      })),
    );
    await seedSnapshot({
      date: fx.meeting_date,
      venue: fx.venue,
      race_no: fx.race_no,
      snapshot: fx.snapshot,
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(
        `http://localhost/v1/races?date=${fx.meeting_date}&venue=${fx.venue}`,
        { headers: READ },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      races: Array<{
        race_no: number;
        observation: { last_successful_poll_at: string | null };
      }>;
    };
    const r3 = body.races.find((r) => r.race_no === fx.race_no)!;
    expect(r3.observation.last_successful_poll_at).toBe(
      fx.expect.last_successful_poll_at,
    );
  });
});
