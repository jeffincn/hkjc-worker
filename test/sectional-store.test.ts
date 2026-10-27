import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  hashSectionalRace,
  parseSectionalPage,
  SECTIONAL_PAGE_URL,
} from "../src/html/sectional";
import {
  ingestMeetingSectionals,
  listPendingSectionalRaces,
  runSectionalBackfillStep,
} from "../src/services/sectionals";
import {
  listSectionals,
  markSectionalProgress,
  replaceRaceSectionals,
} from "../src/store/sectionals";
import { sectional_mini_2026 } from "./fixtures/sectional-html";

async function seedMeeting(): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO meetings (meeting_date, venue, total_races, status, data_source, updated_at)
     VALUES ('2026-10-25', 'ST', 2, 'CLOSED', 'test', ?)`,
  )
    .bind(new Date().toISOString())
    .run();
  for (const race_no of [1, 2]) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO races (meeting_date, venue, race_no, status, distance, data_source, updated_at)
       VALUES ('2026-10-25', 'ST', ?, 'RESULT', 1200, 'test', ?)`,
    )
      .bind(race_no, new Date().toISOString())
      .run();
  }
  // Clear prior sectional state so each test is independent.
  await env.DB.prepare(
    `DELETE FROM sectional_times WHERE meeting_date='2026-10-25' AND venue='ST'`,
  ).run();
  await env.DB.prepare(
    `DELETE FROM sectional_ingest_progress WHERE meeting_date='2026-10-25' AND venue='ST'`,
  ).run();
}

describe("sectional store + backfill", () => {
  beforeEach(async () => {
    await seedMeeting();
  });

  it("dedupes duplicate horse_code in one race (last-wins) without UNIQUE failure", async () => {
    const blankSec = {
      pos: null as number | null,
      margin: null as string | null,
      time: null as number | null,
      splits: null as number[] | null,
    };
    const mk = (
      horse_code: string,
      finishing_order: number,
      finish_time: string,
    ) => ({
      finishing_order,
      horse_no: finishing_order,
      horse_name: `Horse ${horse_code}`,
      horse_code,
      finish_time,
      finish_time_sec: finishing_order === 1 ? 70.0 : 70.5,
      sections: [blankSec, blankSec, blankSec, blankSec, blankSec, blankSec],
      segments: [] as Array<{
        idx: number;
        pos: number | null;
        margin: string | null;
        time: number | null;
        splits: number[] | null;
      }>,
    });

    // Same horse_code twice: first row would collide on PK without dedupe.
    const horses = [
      mk("K502", 1, "1:10.00"),
      mk("K999", 2, "1:10.50"),
      mk("K502", 3, "1:11.00"), // last-wins for K502
    ];
    const content_hash = await hashSectionalRace(
      "2026-10-25",
      "ST",
      1,
      horses,
      null,
    );

    const result = await replaceRaceSectionals(env.DB, {
      meeting_date: "2026-10-25",
      venue: "ST",
      race_no: 1,
      race_info: null,
      horses,
      source_url: "https://example.test/sectional",
      content_hash,
    });
    expect(result.changed).toBe(true);
    expect(result.rows).toBe(2);
    expect(result.skipped_no_code).toBe(0);

    const rows = await listSectionals(env.DB, {
      meeting_date: "2026-10-25",
      venue: "ST",
      race_no: 1,
    });
    expect(rows).toHaveLength(2);
    const k502 = rows.find((r) => r.horse_code === "K502");
    expect(k502?.finishing_order).toBe(3);
    expect(k502?.finish_time).toBe("1:11.00");
    expect(rows.some((r) => r.horse_code === "K999")).toBe(true);

    // Re-run with same hash stays idempotent.
    const again = await replaceRaceSectionals(env.DB, {
      meeting_date: "2026-10-25",
      venue: "ST",
      race_no: 1,
      race_info: null,
      horses,
      source_url: "https://example.test/sectional",
      content_hash,
    });
    expect(again.changed).toBe(false);
  });

  it("upserts sectional_times by horse_code PK and is idempotent on same hash", async () => {
    const page = parseSectionalPage(sectional_mini_2026, {
      meeting_date: "2026-10-25",
      venue: "ST",
      race_no: 1,
      source_url: SECTIONAL_PAGE_URL("2026-10-25", 1),
    });
    expect(page.horses[0].segments[1].splits).toEqual([10.93, 11.22]);

    const content_hash = await hashSectionalRace(
      "2026-10-25",
      "ST",
      1,
      page.horses,
      page.race_info,
    );
    const first = await replaceRaceSectionals(env.DB, {
      meeting_date: "2026-10-25",
      venue: "ST",
      race_no: 1,
      race_info: page.race_info,
      horses: page.horses,
      source_url: page.source_url,
      content_hash,
    });
    expect(first.changed).toBe(true);
    expect(first.rows).toBeGreaterThanOrEqual(2);

    const second = await replaceRaceSectionals(env.DB, {
      meeting_date: "2026-10-25",
      venue: "ST",
      race_no: 1,
      race_info: page.race_info,
      horses: page.horses,
      source_url: page.source_url,
      content_hash,
    });
    expect(second.changed).toBe(false);

    const rows = await listSectionals(env.DB, {
      meeting_date: "2026-10-25",
      venue: "ST",
      race_no: 1,
    });
    expect(rows[0].horse_code).toBe("M046");
    expect(JSON.parse(rows[0].sec1_json!).time).toBe(23.57);
    expect(JSON.parse(rows[0].segments_json!)[1].splits).toEqual([10.93, 11.22]);
  });

  it("lists pending races and resumes after done", async () => {
    await markSectionalProgress(env.DB, {
      meeting_date: "2026-10-25",
      venue: "ST",
      race_no: 1,
      status: "done",
      content_hash: "pre",
      scraped_at: new Date().toISOString(),
    });

    const pendingBefore = await listPendingSectionalRaces(env.DB, {
      date: "2026-10-25",
      venue: "ST",
      from: "2026-10-01",
      to: "2026-10-31",
      limit: 10,
    });
    expect(pendingBefore.map((p) => p.race_no)).toEqual([2]);

    const fetchImpl: typeof fetch = async () =>
      new Response(sectional_mini_2026, {
        status: 200,
        headers: { "content-type": "text/html" },
      });

    const step = await runSectionalBackfillStep(env, {
      date: "2026-10-25",
      venue: "ST",
      from: "2026-10-01",
      to: "2026-10-31",
      limit_races: 5,
      delay_ms: 3000,
      fetchImpl,
    });
    expect(step.processed.some((p) => p.race_no === 2 && p.status === "done")).toBe(true);

    const pendingAfter = await listPendingSectionalRaces(env.DB, {
      date: "2026-10-25",
      venue: "ST",
      from: "2026-10-01",
      to: "2026-10-31",
      limit: 10,
    });
    expect(pendingAfter).toHaveLength(0);
  });

  it("meeting ingest skips already-done races", async () => {
    for (const race_no of [1, 2]) {
      await markSectionalProgress(env.DB, {
        meeting_date: "2026-10-25",
        venue: "ST",
        race_no,
        status: "done",
        content_hash: "x",
        scraped_at: new Date().toISOString(),
      });
    }
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("<html></html>", { status: 200 });
    };
    const result = await ingestMeetingSectionals(env, {
      meeting_date: "2026-10-25",
      venue: "ST",
      race_nos: [1, 2],
      fetchImpl,
    });
    expect(result.processed.every((p) => p.status === "skipped")).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
