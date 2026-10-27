import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { normalizeMeeting, normalizeRunner } from "../src/parse/meeting";
import { persistMeetingTree } from "../src/store/db";
import type { MeetingRaw, RunnerRaw } from "../src/graphql/types";

const AUTH = { Authorization: "Bearer test-api-token" };

async function clear(): Promise<void> {
  for (const t of [
    "runners",
    "races",
    "results",
    "meetings",
    "odds_snapshots",
    "horses",
    "worker_meta",
    "poll_ticks",
  ]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

describe("standby vs declared runner key", () => {
  beforeEach(async () => {
    await clear();
  });

  it("normalizeRunner marks standby and keeps separate horse_no from standbyNo", () => {
    const declared = normalizeRunner({
      no: "1",
      standbyNo: undefined,
      status: "Declared",
      name_en: "ALPHA",
      barrierDrawNumber: "3",
      handicapWeight: "126",
      horse: { code: "H001" },
      jockey: { name_en: "Jockey A" },
      trainer: { name_en: "Trainer A" },
    } as RunnerRaw);
    expect(declared.is_standby).toBe(false);
    expect(declared.horse_no).toBe(1);
    expect(declared.standby_no).toBeNull();
    expect(declared.horse_code).toBe("H001");
    expect(declared.barrier).toBe(3);
    expect(declared.handicap_weight).toBe(126);

    const standby = normalizeRunner({
      no: "",
      standbyNo: "1",
      status: "Standby",
      name_en: "BETA RESERVE",
      barrierDrawNumber: null,
      handicapWeight: "120",
      horse: { code: "H999" },
      jockey: { name_en: "Jockey B" },
      trainer: { name_en: "Trainer B" },
    } as RunnerRaw);
    expect(standby.is_standby).toBe(true);
    expect(standby.horse_no).toBe(1);
    expect(standby.standby_no).toBe(1);
    expect(standby.horse_code).toBe("H999");
    expect(standby.handicap_weight).toBe(120);
  });

  it("persistMeetingTree keeps both rows; standby does not overwrite declared fields", async () => {
    const raw: MeetingRaw = {
      date: "2026-10-25",
      venueCode: "ST",
      status: "DEFINED",
      totalNumberOfRace: 1,
      races: [
        {
          no: 3,
          status: "DEFINED",
          postTime: "2026-10-25T15:00:00+08:00",
          runners: [
            {
              no: "1",
              status: "Declared",
              name_en: "DECLARED ONE",
              barrierDrawNumber: "5",
              handicapWeight: "133",
              horse: { code: "K100" },
              jockey: { name_en: "Z Purton" },
              trainer: { name_en: "F C Lor" },
            },
            {
              no: "",
              standbyNo: "1",
              status: "Standby",
              name_en: "STANDBY ONE",
              barrierDrawNumber: null,
              handicapWeight: "118",
              horse: { code: "K200" },
              jockey: { name_en: "Standby Jockey" },
              trainer: { name_en: "Standby Trainer" },
            },
            {
              no: "2",
              status: "Declared",
              name_en: "DECLARED TWO",
              barrierDrawNumber: "7",
              handicapWeight: "130",
              horse: { code: "K101" },
            },
          ],
        },
      ],
    };

    await persistMeetingTree(env.DB, normalizeMeeting(raw), raw);

    const { results } = await env.DB.prepare(
      `SELECT horse_no, is_standby, standby_no, horse_code, name_en, barrier, handicap_weight,
              jockey_en, trainer_en, status
       FROM runners WHERE meeting_date=? AND venue=? AND race_no=?
       ORDER BY is_standby, horse_no`,
    )
      .bind("2026-10-25", "ST", 3)
      .all<{
        horse_no: number;
        is_standby: number;
        standby_no: number | null;
        horse_code: string | null;
        name_en: string | null;
        barrier: number | null;
        handicap_weight: number | null;
        jockey_en: string | null;
        trainer_en: string | null;
        status: string | null;
      }>();

    expect(results).toHaveLength(3);
    const d1 = results!.find((r) => r.horse_no === 1 && r.is_standby === 0)!;
    const s1 = results!.find((r) => r.horse_no === 1 && r.is_standby === 1)!;
    expect(d1.name_en).toBe("DECLARED ONE");
    expect(d1.horse_code).toBe("K100");
    expect(d1.barrier).toBe(5);
    expect(d1.handicap_weight).toBe(133);
    expect(d1.jockey_en).toBe("Z Purton");
    expect(d1.trainer_en).toBe("F C Lor");

    expect(s1.name_en).toBe("STANDBY ONE");
    expect(s1.horse_code).toBe("K200");
    expect(s1.standby_no).toBe(1);
    expect(s1.handicap_weight).toBe(118);
    expect(s1.jockey_en).toBe("Standby Jockey");
    // Declared fields untouched
    expect(d1.handicap_weight).not.toBe(s1.handicap_weight);
    expect(d1.horse_code).not.toBe(s1.horse_code);
  });

  it("GET /v1/races exposes is_standby; resolve prefers declared", async () => {
    const raw: MeetingRaw = {
      date: "2026-10-25",
      venueCode: "HV",
      status: "DEFINED",
      totalNumberOfRace: 1,
      races: [
        {
          no: 1,
          status: "DEFINED",
          runners: [
            {
              no: "2",
              status: "Declared",
              name_en: "MAIN",
              barrierDrawNumber: "4",
              handicapWeight: "125",
              horse: { code: "H010" },
              jockey: { name_en: "Main J" },
              trainer: { name_en: "Main T" },
            },
            {
              no: "",
              standbyNo: "2",
              status: "Standby",
              name_en: "RESERVE",
              handicapWeight: "115",
              horse: { code: "H020" },
              jockey: { name_en: "Res J" },
              trainer: { name_en: "Res T" },
            },
          ],
        },
      ],
    };
    await persistMeetingTree(env.DB, normalizeMeeting(raw), raw);

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/v1/races?date=2026-10-25&venue=HV", {
        headers: AUTH,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      races: Array<{
        runners: Array<{
          horse_no: number;
          is_standby: boolean;
          standby_no: number | null;
          horse_code: string | null;
          name_en: string | null;
          barrier: number | null;
          handicap_weight: number | null;
          jockey_en: string | null;
        }>;
      }>;
    };
    const runners = body.races[0]!.runners;
    expect(runners).toHaveLength(2);
    const main = runners.find((r) => !r.is_standby)!;
    const resv = runners.find((r) => r.is_standby)!;
    expect(main.horse_no).toBe(2);
    expect(main.horse_code).toBe("H010");
    expect(main.barrier).toBe(4);
    expect(main.handicap_weight).toBe(125);
    expect(main.jockey_en).toBe("Main J");
    expect(resv.horse_no).toBe(2);
    expect(resv.standby_no).toBe(2);
    expect(resv.horse_code).toBe("H020");
    expect(resv.handicap_weight).toBe(115);

    const rCtx = createExecutionContext();
    const rRes = await worker.fetch(
      new Request(
        "http://localhost/v1/horses/resolve?date=2026-10-25&venue=HV&race_no=1&horse_no=2",
        { headers: AUTH },
      ),
      env,
      rCtx,
    );
    await waitOnExecutionContext(rCtx);
    const resolved = (await rRes.json()) as {
      horse_code: string;
      is_standby: boolean;
      name_en: string;
    };
    expect(resolved.is_standby).toBe(false);
    expect(resolved.horse_code).toBe("H010");
    expect(resolved.name_en).toBe("MAIN");

    const sCtx = createExecutionContext();
    const sRes = await worker.fetch(
      new Request(
        "http://localhost/v1/horses/resolve?date=2026-10-25&venue=HV&race_no=1&horse_no=2&is_standby=1",
        { headers: AUTH },
      ),
      env,
      sCtx,
    );
    await waitOnExecutionContext(sCtx);
    const standby = (await sRes.json()) as {
      horse_code: string;
      is_standby: boolean;
      name_en: string;
    };
    expect(standby.is_standby).toBe(true);
    expect(standby.horse_code).toBe("H020");
    expect(standby.name_en).toBe("RESERVE");
  });
});
