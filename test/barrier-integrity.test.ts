import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  BARRIER_INTEGRITY_META_KEY,
  checkBarrierIntegrity,
  upsertBarrierViolation,
} from "../src/parse/barrier-integrity";
import { normalizeMeeting, type NormalizedMeeting } from "../src/parse/meeting";
import type { MeetingRaw } from "../src/graphql/types";
import { getMeta, persistMeetingTree } from "../src/store/db";

const AUTH = { Authorization: "Bearer test-api-token" };

/** Issue #33 snapshot: HV R1 2026-10-21 — barrier 3 duplicated, 11 missing. */
const ISSUE33_BARRIERS: Array<[number, number]> = [
  [1, 6],
  [2, 3],
  [3, 9],
  [4, 10],
  [5, 5],
  [6, 1],
  [7, 7],
  [8, 4],
  [9, 3],
  [10, 8],
  [11, 2],
];

function issue33Meeting(): NormalizedMeeting {
  return {
    meeting_date: "2026-10-21",
    venue: "HV",
    total_races: 1,
    status: "DEFINED",
    data_source: "graphql",
    change_histories: [],
    races: [
      {
        race_no: 1,
        post_time: "2026-10-21T19:15:00+08:00",
        status: "DEFINED",
        distance: 1000,
        going: "GOOD",
        course_desc: null,
        course_code: "A",
        race_class: "Class 4",
        runners: ISSUE33_BARRIERS.map(([horse_no, barrier]) => ({
          horse_no,
          horse_code: `H${String(horse_no).padStart(3, "0")}`,
          horse_id: null,
          name_en: `Horse ${horse_no}`,
          name_ch: null,
          status: "Declared",
          barrier,
          handicap_weight: 126,
          jockey_en: null,
          trainer_en: null,
          last6run: null,
          final_position: null,
          dead_heat: null,
          win_odds: null,
        })),
      },
    ],
  };
}

describe("checkBarrierIntegrity", () => {
  it("accepts a clean 1..N permutation", () => {
    const runners = [1, 2, 3, 4].map((barrier, i) => ({
      horse_no: i + 1,
      status: "Declared",
      barrier,
    }));
    const r = checkBarrierIntegrity(runners);
    expect(r.ok).toBe(true);
    expect(r.barrier_unreliable).toBe(false);
    expect(r.field_size).toBe(4);
    expect(r.duplicates).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it("flags issue #33 HV R1: barrier 3 twice, 11 missing", () => {
    const runners = ISSUE33_BARRIERS.map(([horse_no, barrier]) => ({
      horse_no,
      status: "Declared",
      barrier,
      barrierDrawNumber: String(barrier),
      name_en: `Horse ${horse_no}`,
    }));
    const r = checkBarrierIntegrity(runners);
    expect(r.ok).toBe(false);
    expect(r.barrier_unreliable).toBe(true);
    expect(r.field_size).toBe(11);
    expect(r.duplicates).toEqual([3]);
    expect(r.missing).toEqual([11]);
    expect(r.origin).toBe("hkjc_graphql_barrierDrawNumber");
    expect(r.raw_evidence).toHaveLength(11);
    expect(r.raw_evidence.find((e) => e.horse_no === 9)?.barrierDrawNumber).toBe("3");
  });

  it("excludes scratched and standby from field_size", () => {
    const runners = [
      { horse_no: 1, status: "Declared", barrier: 1 },
      { horse_no: 2, status: "Declared", barrier: 2 },
      { horse_no: 3, status: "Scratched", barrier: 3 },
      { horse_no: 4, status: "Standby", barrier: null },
    ];
    const r = checkBarrierIntegrity(runners);
    expect(r.ok).toBe(true);
    expect(r.field_size).toBe(2);
    expect(r.barriers).toEqual([1, 2]);
  });

  it("upsertBarrierViolation replaces same race_no", () => {
    const base = {
      meeting_date: "2026-10-21",
      venue: "HV",
      race_no: 1,
      field_size: 11,
      duplicates: [3],
      missing: [11],
      raw_evidence: [],
      origin: "hkjc_graphql_barrierDrawNumber" as const,
      updated_at: "t1",
    };
    const next = upsertBarrierViolation([], { ...base, updated_at: "t2" }, 1);
    expect(next).toHaveLength(1);
    expect(next[0]!.updated_at).toBe("t2");
    expect(upsertBarrierViolation(next, null, 1)).toEqual([]);
  });
});

describe("barrier passthrough (source-side, no remapping)", () => {
  it("normalizeMeeting keeps duplicate barrierDrawNumber values as-is", () => {
    const raw: MeetingRaw = {
      date: "2026-10-21",
      venueCode: "HV",
      status: "DEFINED",
      totalNumberOfRace: 1,
      races: [
        {
          no: 1,
          status: "DEFINED",
          runners: ISSUE33_BARRIERS.map(([no, barrier]) => ({
            no: String(no),
            status: "Declared",
            name_en: `Horse ${no}`,
            barrierDrawNumber: String(barrier),
          })),
        },
      ],
    };
    const m = normalizeMeeting(raw);
    const barriers = m.races[0]!.runners.map((r) => r.barrier);
    expect(barriers).toEqual(ISSUE33_BARRIERS.map(([, b]) => b));
    // Worker must NOT invent a corrected 1..11 permutation.
    expect(new Set(barriers).size).toBe(10);
    expect(barriers.filter((b) => b === 3)).toHaveLength(2);
    expect(barriers.includes(11)).toBe(false);
  });
});

describe("persistMeetingTree barrier integrity + scratch clear", () => {
  beforeEach(async () => {
    for (const t of ["runners", "races", "results", "meetings", "horses", "worker_meta"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("records violations in worker_meta and does not invent barriers", async () => {
    const meeting = issue33Meeting();
    await persistMeetingTree(env.DB, meeting, { source: "test" });

    const rows = await env.DB.prepare(
      `SELECT horse_no, barrier FROM runners
       WHERE meeting_date=? AND venue=? AND race_no=? ORDER BY horse_no`,
    )
      .bind("2026-10-21", "HV", 1)
      .all<{ horse_no: number; barrier: number | null }>();
    expect(rows.results?.map((r) => r.barrier)).toEqual(
      ISSUE33_BARRIERS.map(([, b]) => b),
    );

    const meta = await getMeta(env.DB, BARRIER_INTEGRITY_META_KEY);
    expect(meta).toBeTruthy();
    const violations = JSON.parse(meta!) as Array<{
      meeting_date: string;
      venue: string;
      race_no: number;
      duplicates: number[];
      missing: number[];
    }>;
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      meeting_date: "2026-10-21",
      venue: "HV",
      race_no: 1,
      duplicates: [3],
      missing: [11],
    });
  });

  it("clears stale barrier when runner becomes Scratched with null draw", async () => {
    const meeting = issue33Meeting();
    await persistMeetingTree(env.DB, meeting);

    // Horse 9 scratches; HKJC clears barrierDrawNumber → null.
    const scratched = structuredClone(meeting);
    const horse9 = scratched.races[0]!.runners.find((r) => r.horse_no === 9)!;
    horse9.status = "Scratched";
    horse9.barrier = null;
    await persistMeetingTree(env.DB, scratched);

    const row = await env.DB.prepare(
      `SELECT status, barrier FROM runners
       WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?`,
    )
      .bind("2026-10-21", "HV", 1, 9)
      .first<{ status: string; barrier: number | null }>();
    expect(row?.status).toBe("Scratched");
    expect(row?.barrier).toBeNull();

    // Field is now 10 declared with barriers 1..10 (no duplicate 3 among field).
    const meta = await getMeta(env.DB, BARRIER_INTEGRITY_META_KEY);
    const violations = JSON.parse(meta ?? "[]") as unknown[];
    expect(violations).toEqual([]);
  });

  it("rbc backfill null barriers do not wipe live draws for declared runners", async () => {
    const meeting = issue33Meeting();
    await persistMeetingTree(env.DB, meeting);
    const metaBefore = await getMeta(env.DB, BARRIER_INTEGRITY_META_KEY);
    expect(JSON.parse(metaBefore ?? "[]")).toHaveLength(1);

    const backfill: NormalizedMeeting = {
      ...meeting,
      data_source: "graphql_rbc",
      races: [
        {
          ...meeting.races[0]!,
          runners: meeting.races[0]!.runners.map((r) => ({
            ...r,
            barrier: null,
            name_en: null,
            handicap_weight: null,
          })),
        },
      ],
    };
    await persistMeetingTree(env.DB, backfill);

    const row = await env.DB.prepare(
      `SELECT barrier FROM runners
       WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?`,
    )
      .bind("2026-10-21", "HV", 1, 2)
      .first<{ barrier: number | null }>();
    expect(row?.barrier).toBe(3);

    // rbc must not clobber live-poll integrity meta with false "all missing".
    const metaAfter = await getMeta(env.DB, BARRIER_INTEGRITY_META_KEY);
    expect(JSON.parse(metaAfter ?? "[]")).toHaveLength(1);
  });
});

describe("/v1/races + /health barrier integrity surface", () => {
  beforeEach(async () => {
    for (const t of ["runners", "races", "results", "meetings", "horses", "worker_meta"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("flags barrier_unreliable with raw_evidence on /v1/races", async () => {
    await persistMeetingTree(env.DB, issue33Meeting());

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/v1/races?date=2026-10-21&venue=HV", {
        headers: AUTH,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      races: Array<{
        race_no: number;
        barrier_unreliable: boolean;
        barrier_integrity: {
          ok: boolean;
          duplicates: number[];
          missing: number[];
          origin: string;
          raw_evidence: Array<{ horse_no: number; barrier: number | null }>;
        };
        runners: Array<{ horse_no: number; barrier: number | null }>;
      }>;
    };
    const r1 = body.races.find((r) => r.race_no === 1)!;
    expect(r1.barrier_unreliable).toBe(true);
    expect(r1.barrier_integrity.ok).toBe(false);
    expect(r1.barrier_integrity.duplicates).toEqual([3]);
    expect(r1.barrier_integrity.missing).toEqual([11]);
    expect(r1.barrier_integrity.origin).toBe("hkjc_graphql_barrierDrawNumber");
    expect(r1.barrier_integrity.raw_evidence).toHaveLength(11);
    // Raw barriers preserved — no invented correction.
    expect(r1.runners.find((x) => x.horse_no === 9)?.barrier).toBe(3);
    expect(r1.runners.find((x) => x.horse_no === 2)?.barrier).toBe(3);
  });

  it("exposes barrier_integrity_violations on /health", async () => {
    await persistMeetingTree(env.DB, issue33Meeting());

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/health"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alerts: { barrier_integrity_violations: Array<{ race_no: number }> };
      gaps: { barrier_integrity_violations: Array<{ race_no: number }> };
    };
    expect(body.alerts.barrier_integrity_violations).toHaveLength(1);
    expect(body.alerts.barrier_integrity_violations[0]!.race_no).toBe(1);
    expect(body.gaps.barrier_integrity_violations).toHaveLength(1);
  });
});
