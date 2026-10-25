import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  backfillHorseCodesFromStore,
  collidingClothNumbers,
  normalizeHorseName,
  resetAmbiguousHorseCodes,
  runHorseCodeBackfill,
} from "../src/services/horse-code-backfill";

const AUTH = { Authorization: "Bearer test-api-token" };

/**
 * Reproduces prod bug: Declared + Standby share cloth #2; backfill by horse_no
 * alone stamped Declared's brand code onto the Standby runner row.
 */
describe("horse_code Standby cloth collision", () => {
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
      await env.DB.prepare(`DELETE FROM ${t}`).run().catch(() => undefined);
    }
  });

  it("detects colliding cloth numbers across Declared+Standby", () => {
    expect(
      collidingClothNumbers([
        { horse_no: 2, runner_id: "K307", status: "Declared", horse_name: "OTHER" },
        { horse_no: 2, runner_id: "K490", status: "Standby", horse_name: "FAMILY KNIGHT" },
        { horse_no: 3, runner_id: "H001", status: "Declared" },
      ]).has(2),
    ).toBe(true);
    expect(
      collidingClothNumbers([
        { horse_no: 3, runner_id: "H001", status: "Declared" },
      ]).has(3),
    ).toBe(false);
    expect(normalizeHorseName("FAMILY KNIGHT")).toBe("FAMILY KNIGHT");
    expect(normalizeHorseName("Can't Go")).toBe("CANT GO");
  });

  it("does NOT assign Declared brand code to Standby row by horse_no alone", async () => {
    // DB has only one row per horse_no (PK). Standby FAMILY KNIGHT landed as #2.
    await env.DB.prepare(
      `INSERT INTO runners (meeting_date, venue, race_no, horse_no, is_standby, name_en, status, data_source, updated_at)
       VALUES ('2026-10-11','ST',8,2,1,'FAMILY KNIGHT','Standby','graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();

    // Odds correctly has BOTH identities on cloth 2
    const oddsPayload = {
      race_no: 8,
      runners: [
        {
          runner_id: "K307",
          horse_no: 2,
          horse_name: "SOME DECLARED",
          status: "Declared",
        },
        {
          runner_id: "K490",
          horse_no: 2,
          horse_name: "FAMILY KNIGHT",
          status: "Standby",
        },
      ],
    };
    await env.DB.prepare(
      `INSERT INTO odds_snapshots
        (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at)
       VALUES ('2026-10-11','ST',8,'t','h','START_SELL',?,'graphql',?)`,
    )
      .bind(JSON.stringify(oddsPayload), new Date().toISOString())
      .run();

    const store = await backfillHorseCodesFromStore(env.DB, {
      date: "2026-10-11",
      venue: "ST",
      limitMeetings: 10,
    });
    // Must match by name → K490, never stamp K307 via horse_no
    expect(store.from_odds_snapshots).toBe(1);

    const row = await env.DB.prepare(
      `SELECT horse_code FROM runners WHERE meeting_date='2026-10-11' AND venue='ST' AND race_no=8 AND horse_no=2`,
    ).first<{ horse_code: string }>();
    expect(row?.horse_code).toBe("K490");
    expect(row?.horse_code).not.toBe("K307");
  });

  it("resetAmbiguousHorseCodes clears wrong Standby assignment then correct backfill restores", async () => {
    // Simulate bad v1 backfill: Standby SWEET BRIAR wrongly got Declared's L999
    await env.DB.prepare(
      `INSERT INTO runners (meeting_date, venue, race_no, horse_no, is_standby, horse_code, name_en, status, data_source, updated_at)
       VALUES ('2026-10-11','ST',1,1,1,'L999','SWEET BRIAR','Standby','graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      `INSERT INTO runners (meeting_date, venue, race_no, horse_no, is_standby, horse_code, name_en, status, data_source, updated_at)
       VALUES ('2026-10-11','ST',8,2,1,'K307','FAMILY KNIGHT','Standby','graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();

    await env.DB.prepare(
      `INSERT INTO odds_snapshots
        (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at)
       VALUES ('2026-10-11','ST',1,'t','h1','STOP_SELL',?,'graphql',?)`,
    )
      .bind(
        JSON.stringify({
          runners: [
            {
              runner_id: "L001",
              horse_no: 1,
              horse_name: "DECLARED ONE",
              status: "Declared",
            },
            {
              runner_id: "L270",
              horse_no: 1,
              horse_name: "SWEET BRIAR",
              status: "Standby",
            },
          ],
        }),
        new Date().toISOString(),
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO odds_snapshots
        (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at)
       VALUES ('2026-10-11','ST',8,'t','h8','STOP_SELL',?,'graphql',?)`,
    )
      .bind(
        JSON.stringify({
          runners: [
            {
              runner_id: "K307",
              horse_no: 2,
              horse_name: "SOME DECLARED",
              status: "Declared",
            },
            {
              runner_id: "K490",
              horse_no: 2,
              horse_name: "FAMILY KNIGHT",
              status: "Standby",
            },
          ],
        }),
        new Date().toISOString(),
      )
      .run();

    const reset = await resetAmbiguousHorseCodes(env.DB, {
      date: "2026-10-11",
      venue: "ST",
    });
    expect(reset.cleared_standby).toBeGreaterThanOrEqual(2);

    const afterReset = await env.DB.prepare(
      `SELECT horse_code FROM runners WHERE meeting_date='2026-10-11' AND name_en='FAMILY KNIGHT'`,
    ).first<{ horse_code: string | null }>();
    expect(afterReset?.horse_code).toBeNull();

    const out = await runHorseCodeBackfill(env, {
      source: "store",
      date: "2026-10-11",
      venue: "ST",
      limit_meetings: 20,
    });
    expect(out.store?.from_odds_snapshots).toBeGreaterThanOrEqual(2);

    const sweet = await env.DB.prepare(
      `SELECT horse_code FROM runners WHERE name_en='SWEET BRIAR'`,
    ).first<{ horse_code: string }>();
    const family = await env.DB.prepare(
      `SELECT horse_code FROM runners WHERE name_en='FAMILY KNIGHT'`,
    ).first<{ horse_code: string }>();
    expect(sweet?.horse_code).toBe("L270");
    expect(family?.horse_code).toBe("K490");
  });

  it("admin reset_ambiguous + backfill via API", async () => {
    await env.DB.prepare(
      `INSERT INTO runners (meeting_date, venue, race_no, horse_no, is_standby, horse_code, name_en, status, data_source, updated_at)
       VALUES ('2026-10-11','ST',9,2,1,'K514','GLITTERING LEGEND','Standby','graphql',?)`,
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      `INSERT INTO odds_snapshots
        (meeting_date, venue, race_no, snapshot_time, content_hash, pool_status, raw_json, data_source, created_at)
       VALUES ('2026-10-11','ST',9,'t','h','X',?,'graphql',?)`,
    )
      .bind(
        JSON.stringify({
          runners: [
            {
              runner_id: "K514",
              horse_no: 2,
              horse_name: "OTHER DECLARED",
              status: "Declared",
            },
            {
              runner_id: "L109",
              horse_no: 2,
              horse_name: "GLITTERING LEGEND",
              status: "Standby",
            },
          ],
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
          venue: "ST",
          reset_ambiguous: true,
          limit_meetings: 20,
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reset: { cleared_standby: number };
      store: { from_odds_snapshots: number };
    };
    expect(body.reset.cleared_standby).toBeGreaterThanOrEqual(1);

    const row = await env.DB.prepare(
      `SELECT horse_code FROM runners WHERE name_en='GLITTERING LEGEND'`,
    ).first<{ horse_code: string }>();
    expect(row?.horse_code).toBe("L109");
  });
});
