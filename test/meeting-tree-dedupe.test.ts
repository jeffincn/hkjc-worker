import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { NormalizedMeeting } from "../src/parse/meeting";
import {
  meetingTreeContentHash,
  persistMeetingTree,
  setMeta,
  getMeta,
} from "../src/store/db";

function sampleMeeting(overrides?: Partial<NormalizedMeeting>): NormalizedMeeting {
  return {
    meeting_date: "2026-10-07",
    venue: "HV",
    total_races: 1,
    status: "DEFINED",
    data_source: "graphql",
    change_histories: [],
    races: [
      {
        race_no: 1,
        post_time: "2026-10-07T20:15:00+08:00",
        status: "DEFINED",
        distance: 1200,
        going: "GOOD",
        course_desc: "TURF A",
        course_code: "A",
        race_class: "Class 4",
        runners: [
          {
            horse_no: 1,
            name_en: "Alpha",
            name_ch: null,
            status: "Declared",
            barrier: 3,
            handicap_weight: 126,
            jockey_en: "Jockey A",
            trainer_en: "Trainer A",
            last6run: "1/2/3",
            final_position: null,
            dead_heat: null,
            win_odds: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("meeting tree hash + upsert no-op", () => {
  it("hash is stable for identical tree and ignores change_histories", async () => {
    const a = sampleMeeting({
      change_histories: [{ type: "SCRATCH", raceNo: 1, time: "t1" }],
    });
    const b = sampleMeeting({
      change_histories: [{ type: "JOCKEY", raceNo: 2, time: "t2" }],
    });
    expect(await meetingTreeContentHash(a)).toBe(await meetingTreeContentHash(b));
  });

  it("hash changes when runner status changes", async () => {
    const a = sampleMeeting();
    const b = sampleMeeting();
    b.races[0].runners[0].status = "Scratched";
    expect(await meetingTreeContentHash(a)).not.toBe(await meetingTreeContentHash(b));
  });

  it("persistMeetingTree does not rewrite identical rows", async () => {
    const meeting = sampleMeeting();
    const raw = { date: meeting.meeting_date, venueCode: meeting.venue, marker: 1 };

    await persistMeetingTree(env.DB, meeting, raw);

    const before = await env.DB.prepare(
      `SELECT updated_at FROM meetings WHERE meeting_date=? AND venue=?`,
    )
      .bind(meeting.meeting_date, meeting.venue)
      .first<{ updated_at: string }>();

    const beforeRace = await env.DB.prepare(
      `SELECT updated_at FROM races WHERE meeting_date=? AND venue=? AND race_no=?`,
    )
      .bind(meeting.meeting_date, meeting.venue, 1)
      .first<{ updated_at: string }>();

    const beforeRunner = await env.DB.prepare(
      `SELECT updated_at FROM runners WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?`,
    )
      .bind(meeting.meeting_date, meeting.venue, 1, 1)
      .first<{ updated_at: string }>();

    // Ensure clock advances so a naive upsert would bump updated_at
    await new Promise((r) => setTimeout(r, 5));
    await persistMeetingTree(env.DB, meeting, raw);

    const after = await env.DB.prepare(
      `SELECT updated_at FROM meetings WHERE meeting_date=? AND venue=?`,
    )
      .bind(meeting.meeting_date, meeting.venue)
      .first<{ updated_at: string }>();

    const afterRace = await env.DB.prepare(
      `SELECT updated_at FROM races WHERE meeting_date=? AND venue=? AND race_no=?`,
    )
      .bind(meeting.meeting_date, meeting.venue, 1)
      .first<{ updated_at: string }>();

    const afterRunner = await env.DB.prepare(
      `SELECT updated_at FROM runners WHERE meeting_date=? AND venue=? AND race_no=? AND horse_no=?`,
    )
      .bind(meeting.meeting_date, meeting.venue, 1, 1)
      .first<{ updated_at: string }>();

    expect(after?.updated_at).toBe(before?.updated_at);
    expect(afterRace?.updated_at).toBe(beforeRace?.updated_at);
    expect(afterRunner?.updated_at).toBe(beforeRunner?.updated_at);
  });

  it("persistMeetingTree updates when content changes", async () => {
    const meeting = sampleMeeting();
    await persistMeetingTree(env.DB, meeting, { v: 1 });

    const before = await env.DB.prepare(
      `SELECT updated_at, status FROM meetings WHERE meeting_date=? AND venue=?`,
    )
      .bind(meeting.meeting_date, meeting.venue)
      .first<{ updated_at: string; status: string }>();

    await new Promise((r) => setTimeout(r, 5));
    meeting.status = "CLOSED";
    await persistMeetingTree(env.DB, meeting, { v: 2 });

    const after = await env.DB.prepare(
      `SELECT updated_at, status FROM meetings WHERE meeting_date=? AND venue=?`,
    )
      .bind(meeting.meeting_date, meeting.venue)
      .first<{ updated_at: string; status: string }>();

    expect(after?.status).toBe("CLOSED");
    expect(after?.updated_at).not.toBe(before?.updated_at);
  });

  it("setMeta does not rewrite identical values", async () => {
    await setMeta(env.DB, "last_fetch_at", "2026-10-07T12:00:00.000Z");
    const before = await env.DB.prepare(`SELECT updated_at FROM worker_meta WHERE key=?`)
      .bind("last_fetch_at")
      .first<{ updated_at: string }>();

    await new Promise((r) => setTimeout(r, 5));
    await setMeta(env.DB, "last_fetch_at", "2026-10-07T12:00:00.000Z");

    const after = await env.DB.prepare(`SELECT updated_at FROM worker_meta WHERE key=?`)
      .bind("last_fetch_at")
      .first<{ updated_at: string }>();

    expect(after?.updated_at).toBe(before?.updated_at);
    expect(await getMeta(env.DB, "last_fetch_at")).toBe("2026-10-07T12:00:00.000Z");
  });
});
