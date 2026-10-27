import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sectional_mini_2015 } from "./fixtures/sectional-html";
import {
  addCalendarDays,
  listPendingSectionalDateSlots,
  runSectionalBackfillStep,
  SECTIONAL_DATE_MODE_EMPTY_VENUE,
  SECTIONAL_DATE_MODE_DEFAULT_FROM,
} from "../src/services/sectionals";
import { listSectionals, markSectionalProgress } from "../src/store/sectionals";

const EMPTY_HTML = `<html><body><div class="commContent">No race data</div></body></html>`;

async function clearDateRange(from: string, to: string): Promise<void> {
  let d = from;
  while (d <= to) {
    await env.DB.prepare(`DELETE FROM sectional_times WHERE meeting_date=?`).bind(d).run();
    await env.DB.prepare(`DELETE FROM sectional_ingest_progress WHERE meeting_date=?`)
      .bind(d)
      .run();
    d = addCalendarDays(d, 1);
  }
}

describe("sectional date-mode backfill (issue #49)", () => {
  beforeEach(async () => {
    await clearDateRange("2014-09-14", "2014-09-16");
    await clearDateRange("2015-09-01", "2015-09-03");
  });

  it("defaults date-mode from to 2014-09-14 after format probe", () => {
    expect(SECTIONAL_DATE_MODE_DEFAULT_FROM).toBe("2014-09-14");
  });

  it("marks empty / NO RACE calendar days under sentinel venue and continues", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(EMPTY_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    const step = await runSectionalBackfillStep(env, {
      mode: "date",
      from: "2015-09-01",
      to: "2015-09-03",
      limit_races: 5,
      delay_ms: 0,
      allow_below_min_delay: true,
      fetchImpl,
    });

    expect(step.mode).toBe("date");
    expect(step.processed.length).toBe(3);
    expect(step.processed.every((p) => p.status === "empty")).toBe(true);
    expect(step.processed.every((p) => p.venue === SECTIONAL_DATE_MODE_EMPTY_VENUE)).toBe(
      true,
    );
    expect(urls).toHaveLength(3);

    const prog = await env.DB.prepare(
      `SELECT meeting_date, venue, race_no, status FROM sectional_ingest_progress
       WHERE meeting_date BETWEEN '2015-09-01' AND '2015-09-03'
       ORDER BY meeting_date, race_no`,
    ).all<{ meeting_date: string; venue: string; race_no: number; status: string }>();
    expect(prog.results).toEqual([
      { meeting_date: "2015-09-01", venue: "--", race_no: 1, status: "empty" },
      { meeting_date: "2015-09-02", venue: "--", race_no: 1, status: "empty" },
      { meeting_date: "2015-09-03", venue: "--", race_no: 1, status: "empty" },
    ]);
  });

  it("writes sectional_times for a race day without requiring D1 races rows", async () => {
    // No INSERT into races / meetings — date mode must not depend on them.
    const fetchImpl: typeof fetch = async () =>
      new Response(sectional_mini_2015, {
        status: 200,
        headers: { "content-type": "text/html" },
      });

    const step = await runSectionalBackfillStep(env, {
      mode: "date",
      from: "2014-09-14",
      to: "2014-09-14",
      limit_races: 1,
      delay_ms: 0,
      allow_below_min_delay: true,
      fetchImpl,
    });

    expect(step.mode).toBe("date");
    expect(step.processed).toHaveLength(1);
    expect(step.processed[0].status).toBe("done");
    expect(step.processed[0].venue).toBe("ST");
    expect(step.processed[0].race_no).toBe(1);
    expect(step.processed[0].rows).toBeGreaterThanOrEqual(1);
    expect(step.processed[0].content_hash).toBeTruthy();
    expect(step.processed[0].source_url).toBeTruthy();

    const rows = await listSectionals(env.DB, {
      meeting_date: "2014-09-14",
      venue: "ST",
      race_no: 1,
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].horse_code).toBeTruthy();
    expect(rows[0].source_url).toBeTruthy();
    expect(rows[0].content_hash).toBeTruthy();
  });

  it("resumes without rewriting done races and without skipping the next race", async () => {
    let race1Hits = 0;
    let race2Hits = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("RaceNo=1")) race1Hits++;
      if (url.includes("RaceNo=2")) race2Hits++;
      // Race 1 has horses; race 2+ empty → end of meeting.
      if (url.includes("RaceNo=1")) {
        return new Response(sectional_mini_2015, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(EMPTY_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    const first = await runSectionalBackfillStep(env, {
      mode: "date",
      from: "2014-09-14",
      to: "2014-09-14",
      limit_races: 1,
      delay_ms: 0,
      allow_below_min_delay: true,
      fetchImpl,
    });
    expect(first.processed[0].status).toBe("done");
    expect(first.processed[0].race_no).toBe(1);
    expect(race1Hits).toBe(1);
    expect(race2Hits).toBe(0);

    const hashBefore = first.processed[0].content_hash;
    const rowsBefore = await listSectionals(env.DB, {
      meeting_date: "2014-09-14",
      venue: "ST",
      race_no: 1,
    });

    const pending = await listPendingSectionalDateSlots({
      db: env.DB,
      from: "2014-09-14",
      to: "2014-09-14",
      limit: 10,
    });
    expect(pending[0]).toEqual({
      meeting_date: "2014-09-14",
      venue: "ST",
      race_no: 2,
    });

    const second = await runSectionalBackfillStep(env, {
      mode: "date",
      from: "2014-09-14",
      to: "2014-09-14",
      limit_races: 5,
      delay_ms: 0,
      allow_below_min_delay: true,
      fetchImpl,
    });
    expect(second.processed.some((p) => p.race_no === 2 && p.status === "empty")).toBe(
      true,
    );
    expect(race1Hits).toBe(1); // done race not re-fetched
    expect(race2Hits).toBe(1);

    const rowsAfter = await listSectionals(env.DB, {
      meeting_date: "2014-09-14",
      venue: "ST",
      race_no: 1,
    });
    expect(rowsAfter).toHaveLength(rowsBefore.length);
    expect(rowsAfter[0].content_hash).toBe(hashBefore);

    // Third call: meeting fully settled → no fetches.
    race1Hits = 0;
    race2Hits = 0;
    const third = await runSectionalBackfillStep(env, {
      mode: "date",
      from: "2014-09-14",
      to: "2014-09-14",
      limit_races: 5,
      delay_ms: 0,
      allow_below_min_delay: true,
      fetchImpl,
    });
    expect(third.processed).toHaveLength(0);
    expect(race1Hits + race2Hits).toBe(0);
  });

  it("default mode remains races-aligned (does not invent dates without races rows)", async () => {
    await clearDateRange("2026-01-01", "2026-01-02");
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not fetch in empty races mode");
    };
    const step = await runSectionalBackfillStep(env, {
      // mode omitted → races
      from: "2026-01-01",
      to: "2026-01-02",
      limit_races: 5,
      delay_ms: 0,
      allow_below_min_delay: true,
      fetchImpl,
    });
    expect(step.mode).toBe("races");
    expect(step.processed).toHaveLength(0);
  });

  it("listPendingSectionalDateSlots skips empty sentinel days", async () => {
    await markSectionalProgress(env.DB, {
      meeting_date: "2015-09-01",
      venue: SECTIONAL_DATE_MODE_EMPTY_VENUE,
      race_no: 1,
      status: "empty",
      scraped_at: new Date().toISOString(),
    });
    const pending = await listPendingSectionalDateSlots({
      db: env.DB,
      from: "2015-09-01",
      to: "2015-09-02",
      limit: 5,
    });
    expect(pending.every((p) => p.meeting_date !== "2015-09-01")).toBe(true);
    expect(pending[0]?.meeting_date).toBe("2015-09-02");
    expect(pending[0]?.venue).toBeNull();
  });
});
