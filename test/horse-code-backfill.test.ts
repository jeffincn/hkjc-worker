import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  backfillHorseCodesFromStore,
  runHorseCodeBackfill,
} from "../src/services/horse-code-backfill";
import { GRAPHQL_ENDPOINT } from "../src/graphql/queries";

const AUTH = { Authorization: "Bearer test-api-token" };

describe("horse_code backfill (store + admin)", () => {
  beforeEach(async () => {
    for (const t of [
      "runners",
      "races",
      "results",
      "meetings",
      "odds_snapshots",
      "horses",
      "worker_meta",
      "graphql_usage",
    ]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run().catch(() => undefined);
    }
  });

  it("fills null horse_code from odds_snapshots.runner_id when meetings.raw lacks brand codes", async () => {
    // Simulates production: rbcMeeting raw (no horse.code) + live odds with runner_id=H087
    await env.DB.prepare(
      `INSERT INTO meetings (meeting_date, venue, total_races, status, data_source, raw_json, updated_at)
       VALUES ('2026-10-11','ST',1,'RESULT','graphql_rbc',?,?)`,
    )
      .bind(
        JSON.stringify({
          date: "2026-10-11",
          venueCode: "ST",
          races: [{ no: 1, runners: [{ no: "1", status: "Ran" }] }],
        }),
        new Date().toISOString(),
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO runners (meeting_date, venue, race_no, horse_no, name_en, data_source, updated_at)
       VALUES ('2026-10-11','ST',1,1,'SWEET BRIAR','graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      `INSERT INTO results (meeting_date, venue, race_no, horse_no, final_position, data_source, updated_at)
       VALUES ('2026-10-11','ST',1,1,2,'graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();

    const oddsPayload = {
      race_no: 1,
      runners: [
        {
          runner_id: "H234",
          horse_no: 1,
          horse_name: "SWEET BRIAR",
          win_odds: 5.5,
          place_odds: 2.1,
          status: "Declared",
          raw_status: "Ran",
          final_position: 2,
        },
      ],
      payload: { race_no: 1, pool_status: "STOP_SELL", win: {}, pla: {}, last_update: null },
    };
    await env.DB.prepare(
      `INSERT INTO odds_snapshots
        (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at)
       VALUES ('2026-10-11','ST',1,'2026-10-11T16:00:00+08:00','h1','STOP_SELL',?,'graphql',?)`,
    )
      .bind(JSON.stringify(oddsPayload), new Date().toISOString())
      .run();

    const store = await backfillHorseCodesFromStore(env.DB, {
      limitMeetings: 20,
      date: "2026-10-11",
      venue: "ST",
    });
    expect(store.from_meetings_raw).toBe(0); // rbc raw has no horse.code
    expect(store.from_odds_snapshots).toBe(1);
    expect(store.runners_updated).toBe(1);

    const runner = await env.DB.prepare(
      `SELECT horse_code FROM runners WHERE meeting_date='2026-10-11' AND venue='ST' AND race_no=1 AND horse_no=1`,
    ).first<{ horse_code: string }>();
    expect(runner?.horse_code).toBe("H234");

    const result = await env.DB.prepare(
      `SELECT horse_code FROM results WHERE meeting_date='2026-10-11' AND venue='ST' AND race_no=1 AND horse_no=1`,
    ).first<{ horse_code: string }>();
    expect(result?.horse_code).toBe("H234");

    const stub = await env.DB.prepare(
      `SELECT horse_code, name_en FROM horses WHERE horse_code='H234'`,
    ).first<{ horse_code: string; name_en: string }>();
    expect(stub?.name_en).toBe("SWEET BRIAR");

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(
        "http://localhost/v1/horses/resolve?date=2026-10-11&venue=ST&race_no=1&horse_no=1",
        { headers: AUTH },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { horse_code: string };
    expect(body.horse_code).toBe("H234");
  });

  it("POST /v1/admin/backfill-horse-codes runs store mode", async () => {
    await env.DB.prepare(
      `INSERT INTO runners (meeting_date, venue, race_no, horse_no, name_en, data_source, updated_at)
       VALUES ('2026-10-11','HV',2,3,'Alpha','graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      `INSERT INTO odds_snapshots
        (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at)
       VALUES ('2026-10-11','HV',2,'t','h','START_SELL',?,'graphql',?)`,
    )
      .bind(
        JSON.stringify({
          runners: [{ runner_id: "V099", horse_no: 3, horse_name: "Alpha" }],
        }),
        new Date().toISOString(),
      )
      .run();

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/v1/admin/backfill-horse-codes", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "store",
          date: "2026-10-11",
          venue: "HV",
          limit_meetings: 10,
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      store: { from_odds_snapshots: number };
      remaining_null_runners: number;
    };
    expect(body.source).toBe("store");
    expect(body.store.from_odds_snapshots).toBe(1);
    expect(body.remaining_null_runners).toBe(0);
  });

  it("hkjc mode updates from raceMeetings FULL and respects fetch", async () => {
    await env.DB.prepare(
      `INSERT INTO runners (meeting_date, venue, race_no, horse_no, name_en, data_source, updated_at)
       VALUES ('2026-10-12','ST',1,1,'Beta','graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();

    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            raceMeetings: [
              {
                date: "2026-10-12",
                venueCode: "ST",
                totalNumberOfRace: 1,
                status: "DEFINED",
                races: [
                  {
                    no: 1,
                    status: "DEFINED",
                    runners: [
                      {
                        no: "1",
                        name_en: "Beta",
                        status: "Declared",
                        horse: { id: "HK_2023_E001", code: "E001" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const out = await runHorseCodeBackfill(env, {
      source: "hkjc",
      date: "2026-10-12",
      venue: "ST",
      limit_meetings: 5,
      hkjc_delay_ms: 0,
      fetchImpl,
    });
    expect(out.hkjc?.gql_requests).toBe(1);
    expect(out.hkjc?.runners_updated).toBeGreaterThanOrEqual(1);
    expect(out.remaining_null_runners).toBe(0);

    const row = await env.DB.prepare(
      `SELECT horse_code FROM runners WHERE meeting_date='2026-10-12' AND venue='ST' AND horse_no=1`,
    ).first<{ horse_code: string }>();
    expect(row?.horse_code).toBe("E001");
    void GRAPHQL_ENDPOINT;
  });
});
