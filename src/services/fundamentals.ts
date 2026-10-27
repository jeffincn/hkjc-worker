/**
 * Ingest triggers for issue #50 fundamentals (trials, starter PDF gear, Q/QP pools).
 * Horse-page projections run inside refreshMeetingHorses.
 */

import type { Env } from "../env";
import {
  BARRIER_TRIAL_URL,
  parseBarrierTrialPage,
} from "../html/barrier-trial";
import {
  extractPdfLatinText,
  parseGearChangeSummaryText,
  STARTER_PDF_URL,
} from "../html/gear";
import type { PmPoolRaw } from "../graphql/types";
import { contentHash } from "../parse/hash";
import {
  replaceBarrierTrialDay,
  upsertGearFromStarterPdf,
  upsertQuinellaPoolStats,
} from "../store/fundamentals";
import type { SubrequestBudget } from "../util/budget";

/** Polite delay between HKJC HTML/PDF fetches (align with horse refresh). */
export const FUNDAMENTALS_MIN_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function ingestBarrierTrialDay(
  env: Env,
  args: {
    trial_date: string;
    force?: boolean;
    archive?: boolean;
    fetchImpl?: typeof fetch;
    budget?: SubrequestBudget;
    skip_delay?: boolean;
  },
): Promise<{
  trial_date: string;
  status: "done" | "unchanged" | "empty" | "error" | "skipped" | "deferred";
  rows?: number;
  error?: string;
  source_url?: string;
}> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const base = { trial_date: args.trial_date };

  if (!args.force) {
    const prev = await env.DB.prepare(
      `SELECT status FROM barrier_trial_ingest_progress WHERE trial_date=?`,
    )
      .bind(args.trial_date)
      .first<{ status: string }>();
    if (prev?.status === "done") {
      return { ...base, status: "skipped" };
    }
  }

  if (args.budget && !args.budget.canAfford(1)) {
    return { ...base, status: "deferred" };
  }

  if (!args.skip_delay) await sleep(FUNDAMENTALS_MIN_DELAY_MS);

  const tryArchive = args.archive === true;
  const urls = tryArchive
    ? [BARRIER_TRIAL_URL(args.trial_date, true), BARRIER_TRIAL_URL(args.trial_date, false)]
    : [BARRIER_TRIAL_URL(args.trial_date, false), BARRIER_TRIAL_URL(args.trial_date, true)];

  args.budget?.charge(1);

  try {
    let html: string | null = null;
    let source_url = urls[0];
    for (const url of urls) {
      const res = await fetchImpl(url, {
        headers: {
          "User-Agent": "hkjc-data-worker/1.0",
          Accept: "text/html",
        },
        redirect: "follow",
      });
      if (!res.ok) continue;
      const body = await res.text();
      if (/Batch/i.test(body) && /Horse/i.test(body)) {
        html = body;
        source_url = res.url || url;
        break;
      }
    }

    if (!html) {
      await env.DB.prepare(
        `INSERT INTO barrier_trial_ingest_progress (
           trial_date, status, source_url, scraped_at, error_message
         ) VALUES (?, 'empty', ?, ?, ?)
         ON CONFLICT(trial_date) DO UPDATE SET
           status='empty', scraped_at=excluded.scraped_at, error_message=excluded.error_message`,
      )
        .bind(args.trial_date, source_url, new Date().toISOString(), "no trial html")
        .run();
      return { ...base, status: "empty", source_url };
    }

    const page = parseBarrierTrialPage(html, {
      source_url,
      trial_date: args.trial_date,
    });
    const content_hash = await contentHash({
      trial_date: page.trial_date ?? args.trial_date,
      batches: page.batches.map((b) => ({
        batch_no: b.batch_no,
        venue: b.venue,
        track: b.track,
        distance: b.distance,
        going: b.going,
        batch_time: b.batch_time,
        sectional_times: b.sectional_times,
        horses: b.horses.map((h) => ({
          horse_code: h.horse_code,
          running_position: h.running_position,
          finish_time: h.finish_time,
          gear: h.gear,
        })),
      })),
    });

    const upsert = await replaceBarrierTrialDay(env.DB, {
      trial_date: page.trial_date ?? args.trial_date,
      batches: page.batches,
      source_url,
      content_hash,
      env,
    });

    return {
      ...base,
      status: upsert.changed ? (upsert.rows > 0 ? "done" : "empty") : "unchanged",
      rows: upsert.rows,
      source_url,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await env.DB.prepare(
      `INSERT INTO barrier_trial_ingest_progress (
         trial_date, status, scraped_at, error_message
       ) VALUES (?, 'error', ?, ?)
       ON CONFLICT(trial_date) DO UPDATE SET
         status='error', scraped_at=excluded.scraped_at, error_message=excluded.error_message`,
    )
      .bind(args.trial_date, new Date().toISOString(), msg.slice(0, 500))
      .run();
    return { ...base, status: "error", error: msg };
  }
}

/**
 * Fetch starter_all.pdf and upsert Gear Change Summary rows (when extractable).
 * Horse-page gear remains primary; PDF supplements race-day changes.
 */
export async function ingestStarterGearPdf(
  env: Env,
  args: {
    meeting_date: string;
    venue: string;
    fetchImpl?: typeof fetch;
    budget?: SubrequestBudget;
    skip_delay?: boolean;
    /** Injected text (tests) — skips PDF fetch. */
    text?: string;
  },
): Promise<{
  meeting_date: string;
  status: "done" | "empty" | "error" | "deferred" | "unavailable";
  rows?: number;
  error?: string;
  source_url?: string;
}> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const source_url = STARTER_PDF_URL(args.meeting_date);
  const base = { meeting_date: args.meeting_date, source_url };

  let text = args.text ?? null;
  if (text == null) {
    if (args.budget && !args.budget.canAfford(1)) {
      return { ...base, status: "deferred" };
    }
    if (!args.skip_delay) await sleep(FUNDAMENTALS_MIN_DELAY_MS);
    args.budget?.charge(1);
    try {
      const res = await fetchImpl(source_url, {
        headers: {
          "User-Agent": "hkjc-data-worker/1.0",
          Accept: "application/pdf",
        },
        redirect: "follow",
      });
      if (res.status === 404) {
        return { ...base, status: "unavailable" };
      }
      if (!res.ok) {
        return { ...base, status: "error", error: `HTTP ${res.status}` };
      }
      const buf = await res.arrayBuffer();
      text = extractPdfLatinText(buf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ...base, status: "error", error: msg };
    }
  }

  if (!text || !/Gear\s+Change\s+Summary/i.test(text)) {
    return { ...base, status: "empty" };
  }

  const parsed = parseGearChangeSummaryText(text, {
    meeting_date: args.meeting_date,
  });
  const rows = await upsertGearFromStarterPdf(env.DB, {
    meeting_date: args.meeting_date,
    venue: args.venue,
    rows: parsed.rows,
    source_url,
    env,
  });
  return { ...base, status: rows > 0 ? "done" : "empty", rows };
}

/** Persist QIN/QPL pool investment from GraphQL poolInvs (no odds cells). */
export async function persistQuinellaPoolsFromMeeting(
  env: Env,
  args: {
    meeting_date: string;
    venue: string;
    poolInvs: PmPoolRaw[] | null | undefined;
  },
): Promise<number> {
  const pools: Array<{
    race_no: number;
    pool_type: string;
    investment: number | null;
    status: string | null;
    sell_status: string | null;
    last_update_time: string | null;
  }> = [];

  for (const p of args.poolInvs ?? []) {
    const t = (p.oddsType ?? "").toUpperCase();
    if (t !== "QIN" && t !== "QPL") continue;
    const race_no = p.leg?.number ?? p.leg?.races?.[0];
    if (race_no == null) continue;
    const inv =
      p.investment == null || p.investment === ""
        ? null
        : Number(p.investment);
    pools.push({
      race_no: Number(race_no),
      pool_type: t,
      investment: Number.isFinite(inv as number) ? (inv as number) : null,
      status: p.status ?? null,
      sell_status: p.sellStatus ?? null,
      last_update_time: p.lastUpdateTime ?? null,
    });
  }

  if (pools.length === 0) return 0;
  return upsertQuinellaPoolStats(env.DB, {
    meeting_date: args.meeting_date,
    venue: args.venue,
    pools,
    env,
  });
}
