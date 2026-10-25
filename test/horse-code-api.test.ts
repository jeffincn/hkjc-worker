import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  horseCodeFromRunnerFields,
  isHkjcHorseCode,
  normalizeHorseCode,
} from "../src/parse/horse-code";
import type { NormalizedMeeting } from "../src/parse/meeting";
import { buildRaceOddsSnapshot } from "../src/parse/odds";
import { persistMeetingTree } from "../src/store/db";
import {
  backfillHorseCodesFromRawMeetings,
  backfillHorseCodesFromStore,
  runHorseCodeBackfill,
} from "../src/services/horse-code-backfill";

const AUTH = { Authorization: "Bearer test-api-token" };

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, { headers: AUTH }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: await res.json() };
}

describe("horse_code helpers", () => {
  it("normalizes brand codes", () => {
    expect(isHkjcHorseCode("H087")).toBe(true);
    expect(isHkjcHorseCode("h087")).toBe(true);
    expect(isHkjcHorseCode("no:1")).toBe(false);
    expect(normalizeHorseCode("h087")).toBe("H087");
    expect(horseCodeFromRunnerFields({ runner_id: "H087" })).toBe("H087");
    expect(horseCodeFromRunnerFields({ runner_id: "no:1" })).toBeNull();
  });
});

describe("horse_code API + storage", () => {
  beforeEach(async () => {
    for (const t of [
      "runners",
      "races",
      "results",
      "meetings",
      "odds_snapshots",
      "horses",
      "worker_meta",
    ]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("persists horse_code on runners and creates horses stub for /v1/horses/:code", async () => {
    const meeting: NormalizedMeeting = {
      meeting_date: "2026-10-12",
      venue: "HV",
      total_races: 1,
      status: "DEFINED",
      data_source: "graphql",
      change_histories: [],
      races: [
        {
          race_no: 1,
          post_time: "2026-10-12T20:15:00+08:00",
          status: "DEFINED",
          distance: 1200,
          going: "GOOD",
          course_desc: null,
          course_code: "A",
          race_class: "Class 4",
          runners: [
            {
              horse_no: 7,
              is_standby: false,
              standby_no: null,
              horse_code: "H087",
              horse_id: "HK_2022_H087",
              name_en: "CAN'T GO WONG",
              name_ch: null,
              status: "Declared",
              barrier: 1,
              handicap_weight: 126,
              jockey_en: "Z Purton",
              trainer_en: "F C Lor",
              last6run: null,
              final_position: null,
              dead_heat: null,
              win_odds: null,
            },
          ],
        },
      ],
    };
    await persistMeetingTree(env.DB, meeting, {
      date: "2026-10-12",
      venueCode: "HV",
      races: [
        {
          no: 1,
          runners: [
            {
              no: "7",
              name_en: "CAN'T GO WONG",
              horse: { id: "HK_2022_H087", code: "H087" },
            },
          ],
        },
      ],
    });

    const runner = await env.DB.prepare(
      `SELECT horse_code FROM runners WHERE meeting_date=? AND venue=? AND race_no=1 AND horse_no=7`,
    )
      .bind("2026-10-12", "HV")
      .first<{ horse_code: string }>();
    expect(runner?.horse_code).toBe("H087");

    const horse = await getJson("/v1/horses/H087");
    expect(horse.status).toBe(200);
    expect((horse.body as { horse: { horse_code: string } }).horse.horse_code).toBe(
      "H087",
    );

    const byId = await getJson("/v1/horses/HK_2022_H087");
    expect(byId.status).toBe(200);

    const races = await getJson("/v1/races?date=2026-10-12&venue=HV");
    expect(races.status).toBe(200);
    const raceBody = races.body as {
      races: Array<{ runners: Array<{ horse_no: number; horse_code: string }> }>;
    };
    expect(raceBody.races[0].runners[0].horse_code).toBe("H087");

    const resolved = await getJson(
      "/v1/horses/resolve?date=2026-10-12&venue=HV&race_no=1&horse_no=7",
    );
    expect(resolved.status).toBe(200);
    expect((resolved.body as { horse_code: string }).horse_code).toBe("H087");
  });

  it("exposes horse_code on results and odds runners", async () => {
    await env.DB.prepare(
      `INSERT INTO meetings (meeting_date, venue, total_races, status, data_source, updated_at)
       VALUES ('2026-10-12','HV',1,'RESULT','graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      `INSERT INTO races (meeting_date, venue, race_no, post_time, status, data_source, updated_at)
       VALUES ('2026-10-12','HV',1,NULL,'RESULT','graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      `INSERT INTO runners (meeting_date, venue, race_no, horse_no, horse_code, name_en, data_source, updated_at)
       VALUES ('2026-10-12','HV',1,1,'H087','Alpha','graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      `INSERT INTO results (meeting_date, venue, race_no, horse_no, horse_code, final_position, data_source, updated_at)
       VALUES ('2026-10-12','HV',1,1,'H087',3,'graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();

    const snap = buildRaceOddsSnapshot({
      race: {
        no: 1,
        runners: [
          {
            no: "1",
            name_en: "Alpha",
            status: "Ran",
            horse: { code: "H087", id: "HK_2022_H087" },
          },
        ],
      },
      winPool: {
        oddsType: "WIN",
        sellStatus: "STOP_SELL",
        lastUpdateTime: "2026-10-12T20:00:00+08:00",
        oddsNodes: [{ combString: "01", oddsValue: "4.0" }],
      },
    });
    expect(snap.runners[0].horse_code).toBe("H087");
    await env.DB.prepare(
      `INSERT INTO odds_snapshots
        (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at)
       VALUES ('2026-10-12','HV',1,?,?,?,?, 'graphql', ?)`,
    )
      .bind(
        snap.snapshot_time,
        "hash1",
        snap.pool_status,
        JSON.stringify(snap),
        new Date().toISOString(),
      )
      .run();

    const results = await getJson("/v1/results?date=2026-10-12&venue=HV");
    expect(results.status).toBe(200);
    expect(
      (results.body as { results: Array<{ horse_code: string }> }).results[0]
        .horse_code,
    ).toBe("H087");

    const odds = await getJson(
      "/v1/odds/latest?date=2026-10-12&venue=HV&race_no=1",
    );
    expect(odds.status).toBe(200);
    const oddsBody = odds.body as {
      snapshot: { data: { runners: Array<{ horse_code: string }> } };
    };
    expect(oddsBody.snapshot.data.runners[0].horse_code).toBe("H087");

    const hist = await getJson(
      "/v1/odds/history?date=2026-10-12&venue=HV&race_no=1",
    );
    expect(hist.status).toBe(200);
    const histBody = hist.body as {
      snapshots: Array<{ data: { runners: Array<{ horse_code: string }> } }>;
    };
    expect(histBody.snapshots[0].data.runners[0].horse_code).toBe("H087");
  });

  it("backfills horse_code from meetings.raw_json without network", async () => {
    const raw = {
      date: "2026-10-01",
      venueCode: "ST",
      races: [
        {
          no: 2,
          runners: [
            {
              no: "3",
              name_en: "Beta",
              horse: { code: "V123", id: "HK_2021_V123" },
            },
          ],
        },
      ],
    };
    await env.DB.prepare(
      `INSERT INTO meetings (meeting_date, venue, total_races, status, data_source, raw_json, updated_at)
       VALUES ('2026-10-01','ST',1,'DEFINED','graphql',?,?)`,
    )
      .bind(JSON.stringify(raw), new Date().toISOString())
      .run();
    await env.DB.prepare(
      `INSERT INTO runners (meeting_date, venue, race_no, horse_no, name_en, data_source, updated_at)
       VALUES ('2026-10-01','ST',2,3,'Beta','graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();

    const out = await backfillHorseCodesFromRawMeetings(env.DB, {
      limitMeetings: 10,
    });
    expect(out.runners_updated).toBe(1);
    const row = await env.DB.prepare(
      `SELECT horse_code FROM runners WHERE meeting_date='2026-10-01' AND venue='ST' AND race_no=2 AND horse_no=3`,
    ).first<{ horse_code: string }>();
    expect(row?.horse_code).toBe("V123");
    const stub = await env.DB.prepare(
      `SELECT horse_code FROM horses WHERE horse_code='V123'`,
    ).first();
    expect(stub).toBeTruthy();
  });
});
