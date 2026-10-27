import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  BARRIER_INTEGRITY_META_KEY,
  checkBarrierIntegrity,
  inferDrawSize,
  upsertBarrierViolation,
} from "../src/parse/barrier-integrity";
import { normalizeMeeting, type NormalizedMeeting } from "../src/parse/meeting";
import type { MeetingRaw } from "../src/graphql/types";
import { getMeta, persistMeetingTree, setMeta } from "../src/store/db";

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

function runner(
  horse_no: number,
  barrier: number | null,
  status = "Declared",
): NormalizedMeeting["races"][0]["runners"][0] {
  return {
    horse_no,
    horse_code: `H${String(Math.abs(horse_no)).padStart(3, "0")}`,
    horse_id: null,
    name_en: `Horse ${horse_no}`,
    name_ch: null,
    status,
    is_standby: status === "Standby",
    standby_no: status === "Standby" ? horse_no : null,
    barrier,
    handicap_weight: 126,
    jockey_en: null,
    trainer_en: null,
    last6run: null,
    final_position: null,
    dead_heat: null,
    win_odds: null,
  };
}

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
        runners: ISSUE33_BARRIERS.map(([horse_no, barrier]) =>
          runner(horse_no, barrier),
        ),
      },
    ],
  };
}

/**
 * Production false-positive (2026-10-21 HV R2 after #35): scratched horses 1 & 2
 * are completely absent from the payload. 10 declared runners remain; original
 * barrier 12 is kept → old logic set draw_size=10 and flagged out_of_range=[12].
 *
 * Shape mirrors the live report: field_size=10, barriers include 12, duplicates=[].
 */
const HV_R2_ABSENT_SCRATCH_BARRIERS: Array<[number, number]> = [
  [1, 3],
  [2, 4],
  [3, 5],
  [4, 6],
  [5, 7],
  [6, 8],
  [7, 9],
  [8, 10],
  [9, 11],
  [10, 12], // cloth may be renumbered in store; barrier 12 is the original draw
];

function hvR2AbsentScratchMeeting(): NormalizedMeeting {
  return {
    meeting_date: "2026-10-21",
    venue: "HV",
    total_races: 1,
    status: "DEFINED",
    data_source: "graphql",
    change_histories: [],
    races: [
      {
        race_no: 2,
        post_time: "2026-10-21T19:45:00+08:00",
        status: "DEFINED",
        distance: 1200,
        going: "GOOD",
        course_desc: null,
        course_code: "A",
        race_class: "Class 4",
        wagering_field_size: 12,
        runners: HV_R2_ABSENT_SCRATCH_BARRIERS.map(([n, b]) => runner(n, b)),
      },
    ],
  };
}

/** Same race when scratched cloths stay in the payload as Scratched rows. */
function scratchGapMeeting(): NormalizedMeeting {
  const declared: Array<[number, number]> = [
    [1, 1],
    [2, 2],
    [3, 3],
    [5, 5],
    [6, 6],
    [7, 7],
    [9, 9],
    [10, 10],
    [11, 11],
    [12, 12],
  ];
  return {
    meeting_date: "2026-10-21",
    venue: "HV",
    total_races: 1,
    status: "DEFINED",
    data_source: "graphql",
    change_histories: [],
    races: [
      {
        race_no: 2,
        post_time: "2026-10-21T19:45:00+08:00",
        status: "DEFINED",
        distance: 1200,
        going: "GOOD",
        course_desc: null,
        course_code: "A",
        race_class: "Class 4",
        wagering_field_size: 12,
        runners: [
          ...declared.map(([n, b]) => runner(n, b)),
          runner(4, null, "Scratched"),
          runner(8, null, "Scratched"),
        ],
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
    expect(r.draw_size).toBe(4);
    expect(r.duplicates).toEqual([]);
    expect(r.out_of_range).toEqual([]);
    expect(r.null_barrier_horse_nos).toEqual([]);
  });

  it("flags issue #33 HV R1: duplicate barrier 3 (source-side)", () => {
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
    expect(r.draw_size).toBe(11);
    expect(r.duplicates).toEqual([3]);
    expect(r.out_of_range).toEqual([]);
    expect(r.null_barrier_horse_nos).toEqual([]);
    // Gap at 11 is informational (consequence of dup), not the sole rule.
    expect(r.missing).toContain(11);
    expect(r.origin).toBe("hkjc_graphql_barrierDrawNumber");
    expect(r.raw_evidence).toHaveLength(11);
    expect(r.raw_evidence.find((e) => e.horse_no === 9)?.barrierDrawNumber).toBe(
      "3",
    );
  });

  it("does NOT flag scratch-induced gaps when scratched rows remain", () => {
    const runners = [
      { horse_no: 1, status: "Declared", barrier: 1 },
      { horse_no: 2, status: "Declared", barrier: 2 },
      { horse_no: 3, status: "Declared", barrier: 3 },
      { horse_no: 4, status: "Scratched", barrier: null },
      { horse_no: 5, status: "Declared", barrier: 5 },
      { horse_no: 6, status: "Declared", barrier: 6 },
      { horse_no: 7, status: "Declared", barrier: 7 },
      { horse_no: 8, status: "Scratched", barrier: null },
      { horse_no: 9, status: "Declared", barrier: 9 },
      { horse_no: 10, status: "Declared", barrier: 10 },
      { horse_no: 11, status: "Declared", barrier: 11 },
      { horse_no: 12, status: "Declared", barrier: 12 },
    ];
    const r = checkBarrierIntegrity(runners);
    expect(r.field_size).toBe(10);
    expect(r.draw_size).toBe(12);
    expect(r.barriers).toContain(12);
    expect(r.missing).toEqual([4, 8]);
    expect(r.duplicates).toEqual([]);
    expect(r.out_of_range).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.barrier_unreliable).toBe(false);
  });

  it("2026-10-21 HV R2: scratched horses absent — barrier 12 not out_of_range", () => {
    // Production after #35: draw_size was wrongly 10, out_of_range=[12].
    const runners = HV_R2_ABSENT_SCRATCH_BARRIERS.map(([horse_no, barrier]) => ({
      horse_no,
      status: "Declared",
      barrier,
    }));
    expect(runners).toHaveLength(10);
    expect(inferDrawSize(runners)).toBe(12); // max(barrier)=12, not present count
    expect(inferDrawSize(runners, { wageringFieldSize: 12 })).toBe(12);

    const r = checkBarrierIntegrity(runners);
    expect(r.field_size).toBe(10);
    expect(r.draw_size).toBe(12);
    expect(r.barriers).toContain(12);
    expect(r.duplicates).toEqual([]);
    expect(r.out_of_range).toEqual([]);
    expect(r.null_barrier_horse_nos).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.barrier_unreliable).toBe(false);
  });

  it("infers draw_size from max(horse_no) when scratched cloths absent", () => {
    const runners = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((horse_no) => ({
      horse_no,
      status: "Declared",
      barrier: horse_no, // includes barrier 12
    }));
    expect(inferDrawSize(runners)).toBe(12);
    const r = checkBarrierIntegrity(runners);
    expect(r.ok).toBe(true);
    expect(r.out_of_range).toEqual([]);
  });

  it("flags barrier outside 1..draw_size (corrupt >14 ignored for infer)", () => {
    const runners = [
      { horse_no: 1, status: "Declared", barrier: 1 },
      { horse_no: 2, status: "Declared", barrier: 2 },
      { horse_no: 3, status: "Declared", barrier: 15 },
      { horse_no: 4, status: "Scratched", barrier: null },
    ];
    // 15 must not inflate draw_size past present/max horse_no.
    expect(inferDrawSize(runners)).toBe(4);
    const r = checkBarrierIntegrity(runners);
    expect(r.draw_size).toBe(4);
    expect(r.out_of_range).toEqual([15]);
    expect(r.ok).toBe(false);
    expect(r.barrier_unreliable).toBe(true);
  });

  it("flags declared runner with null barrier", () => {
    const runners = [
      { horse_no: 1, status: "Declared", barrier: 1 },
      { horse_no: 2, status: "Declared", barrier: null },
      { horse_no: 3, status: "Declared", barrier: 3 },
    ];
    const r = checkBarrierIntegrity(runners);
    expect(r.null_barrier_horse_nos).toEqual([2]);
    expect(r.ok).toBe(false);
    expect(r.barrier_unreliable).toBe(true);
  });

  it("excludes standby from draw_size and field_size", () => {
    const runners = [
      { horse_no: 1, status: "Declared", barrier: 1 },
      { horse_no: 2, status: "Declared", barrier: 2 },
      { horse_no: 3, status: "Scratched", barrier: null },
      { horse_no: 4, status: "Standby", barrier: null },
    ];
    const r = checkBarrierIntegrity(runners);
    expect(r.ok).toBe(true);
    expect(r.field_size).toBe(2);
    expect(r.draw_size).toBe(3);
    expect(r.barriers).toEqual([1, 2]);
  });

  it("upsertBarrierViolation replaces same race_no", () => {
    const base = {
      meeting_date: "2026-10-21",
      venue: "HV",
      race_no: 1,
      field_size: 11,
      draw_size: 11,
      duplicates: [3],
      out_of_range: [] as number[],
      null_barrier_horse_nos: [] as number[],
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

  it("records R1 duplicate violation in worker_meta without inventing barriers", async () => {
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
      out_of_range: number[];
    }>;
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      meeting_date: "2026-10-21",
      venue: "HV",
      race_no: 1,
      duplicates: [3],
      out_of_range: [],
    });
  });

  it("does not record scratch-gap races as violations", async () => {
    await persistMeetingTree(env.DB, scratchGapMeeting());
    const meta = await getMeta(env.DB, BARRIER_INTEGRITY_META_KEY);
    expect(JSON.parse(meta ?? "[]")).toEqual([]);
  });

  it("does not record HV R2 absent-scratch shape as violations", async () => {
    await persistMeetingTree(env.DB, hvR2AbsentScratchMeeting());
    const meta = await getMeta(env.DB, BARRIER_INTEGRITY_META_KEY);
    expect(JSON.parse(meta ?? "[]")).toEqual([]);
  });

  it("clears stale barrier when runner becomes Scratched with null draw", async () => {
    const meeting = issue33Meeting();
    await persistMeetingTree(env.DB, meeting);

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

    // After scratch: no duplicate among declared; gap at 3's mate is OK.
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

  it("flags R1 duplicate on /v1/races with raw_evidence", async () => {
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
          draw_size: number;
          duplicates: number[];
          out_of_range: number[];
          null_barrier_horse_nos: number[];
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
    expect(r1.barrier_integrity.out_of_range).toEqual([]);
    expect(r1.barrier_integrity.draw_size).toBe(11);
    expect(r1.barrier_integrity.origin).toBe("hkjc_graphql_barrierDrawNumber");
    expect(r1.runners.find((x) => x.horse_no === 9)?.barrier).toBe(3);
    expect(r1.runners.find((x) => x.horse_no === 2)?.barrier).toBe(3);
  });

  it("does not flag scratch-gap race on /v1/races", async () => {
    await persistMeetingTree(env.DB, scratchGapMeeting());

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/v1/races?date=2026-10-21&venue=HV", {
        headers: AUTH,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      races: Array<{
        race_no: number;
        barrier_unreliable: boolean;
        barrier_integrity: {
          ok: boolean;
          field_size: number;
          draw_size: number;
          duplicates: number[];
          out_of_range: number[];
          missing: number[];
        };
      }>;
    };
    const r2 = body.races.find((r) => r.race_no === 2)!;
    expect(r2.barrier_unreliable).toBe(false);
    expect(r2.barrier_integrity.ok).toBe(true);
    expect(r2.barrier_integrity.field_size).toBe(10);
    expect(r2.barrier_integrity.draw_size).toBe(12);
    expect(r2.barrier_integrity.duplicates).toEqual([]);
    expect(r2.barrier_integrity.out_of_range).toEqual([]);
    expect(r2.barrier_integrity.missing).toEqual([4, 8]);
  });

  it("does not flag 2026-10-21 HV R2 absent-scratch shape on /v1/races", async () => {
    await persistMeetingTree(env.DB, hvR2AbsentScratchMeeting());

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/v1/races?date=2026-10-21&venue=HV", {
        headers: AUTH,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      races: Array<{
        race_no: number;
        barrier_unreliable: boolean;
        barrier_integrity: {
          ok: boolean;
          field_size: number;
          draw_size: number;
          out_of_range: number[];
        };
      }>;
    };
    const r2 = body.races.find((r) => r.race_no === 2)!;
    expect(r2.barrier_unreliable).toBe(false);
    expect(r2.barrier_integrity.field_size).toBe(10);
    expect(r2.barrier_integrity.draw_size).toBe(12);
    expect(r2.barrier_integrity.out_of_range).toEqual([]);
  });

  it("keeps /health violations in sync with /v1/races (even if meta was empty)", async () => {
    // Simulate post-deploy: runners in D1, meta never written (tree-hash skip).
    await persistMeetingTree(env.DB, issue33Meeting());
    await setMeta(env.DB, BARRIER_INTEGRITY_META_KEY, "[]");
    expect(JSON.parse((await getMeta(env.DB, BARRIER_INTEGRITY_META_KEY))!)).toEqual(
      [],
    );

    const racesCtx = createExecutionContext();
    const racesRes = await worker.fetch(
      new Request("http://localhost/v1/races?date=2026-10-21&venue=HV", {
        headers: AUTH,
      }),
      env,
      racesCtx,
    );
    await waitOnExecutionContext(racesCtx);
    const racesBody = (await racesRes.json()) as {
      races: Array<{ race_no: number; barrier_unreliable: boolean }>;
    };
    expect(racesBody.races[0]!.barrier_unreliable).toBe(true);

    const healthCtx = createExecutionContext();
    const healthRes = await worker.fetch(
      new Request("http://localhost/health"),
      env,
      healthCtx,
    );
    await waitOnExecutionContext(healthCtx);
    const health = (await healthRes.json()) as {
      alerts: {
        barrier_integrity_violations: Array<{
          race_no: number;
          duplicates: number[];
        }>;
      };
      gaps: { barrier_integrity_violations: unknown[] };
    };
    expect(health.alerts.barrier_integrity_violations).toHaveLength(1);
    expect(health.alerts.barrier_integrity_violations[0]).toMatchObject({
      race_no: 1,
      duplicates: [3],
    });
    expect(health.gaps.barrier_integrity_violations).toHaveLength(1);
  });

  it("clears health violations when only scratch-gap races remain", async () => {
    await persistMeetingTree(env.DB, issue33Meeting());
    expect(
      JSON.parse((await getMeta(env.DB, BARRIER_INTEGRITY_META_KEY))!),
    ).toHaveLength(1);

    // Replace meeting with scratch-gap-only race 2.
    await env.DB.prepare(`DELETE FROM runners`).run();
    await env.DB.prepare(`DELETE FROM races`).run();
    await persistMeetingTree(env.DB, scratchGapMeeting());

    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/v1/races?date=2026-10-21&venue=HV", {
        headers: AUTH,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const healthCtx = createExecutionContext();
    const healthRes = await worker.fetch(
      new Request("http://localhost/health"),
      env,
      healthCtx,
    );
    await waitOnExecutionContext(healthCtx);
    const health = (await healthRes.json()) as {
      alerts: { barrier_integrity_violations: unknown[] };
    };
    expect(health.alerts.barrier_integrity_violations).toEqual([]);
  });
});
