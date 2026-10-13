/**
 * Dry-run: count duplicate / redundant pushes from push_events (preferred)
 * or push_log payload_hash, and estimate expected hourly volume after the
 * dedupe / off-window coalesce fixes.
 *
 * Usage (local D1 via wrangler):
 *   npx wrangler d1 execute hkjc --local --command \
 *     "SELECT event_type, payload_json, created_at FROM push_events ORDER BY id DESC LIMIT 5000"
 *   # or pipe JSON into this script:
 *   npx tsx scripts/push-dedupe-dryrun.ts --from-json events.json
 *
 * Against a running worker with API access, set BASE_URL + API_TOKEN and:
 *   npx tsx scripts/push-dedupe-dryrun.ts --api
 *
 * Pure estimate (no DB):
 *   npx tsx scripts/push-dedupe-dryrun.ts --estimate-only
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type EventRow = {
  event_type?: string;
  event?: string;
  payload_json?: string;
  payload?: unknown;
  created_at?: string;
  sent_at?: string;
  payload_hash?: string;
};

const OFFWINDOW_HEARTBEAT_PER_HOUR = 3600 / 1800; // OFFDAY_HEARTBEAT 30m → 2
const OFFWINDOW_DELTA_CAP_PER_HOUR = 3600 / 300; // PUSH_OFFWINDOW_COALESCE 300s → ≤12
const INWINDOW_HEARTBEAT_PER_HOUR = 3600 / 300; // 5m → 12
const INWINDOW_FULL_SNAPSHOT_PER_HOUR = 3600 / 300; // PUSH_FULL_SNAPSHOT 5m → ~12
const INWINDOW_DELTA_COALESCE_S = 2;
const INWINDOW_DELTA_CAP_PER_HOUR = 3600 / INWINDOW_DELTA_COALESCE_S; // ≤1800 theoretical

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
    return out;
  }
  return value;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Mirrors src/push/dedupe.ts stablePushBody (best-effort for dry-run). */
function stableBody(envelope: Record<string, unknown>): unknown {
  const changes = Array.isArray(envelope.changes)
    ? (envelope.changes as Array<Record<string, unknown>>).map((c) => ({
        race_no: c.race_no,
        runner_id: c.runner_id ?? null,
        horse_no: c.horse_no ?? c.runner_no,
        status: c.status ?? null,
        bet_type: c.bet_type,
        pool: c.pool ?? c.bet_type,
        prev_odds: c.prev_odds,
        new_odds: c.new_odds,
        pool_status: c.pool_status ?? null,
      }))
    : null;
  const races = Array.isArray(envelope.races)
    ? (envelope.races as Array<Record<string, unknown>>).map((r) => ({
        race_no: r.race_no,
        post_time: r.post_time,
        pool_status: r.pool_status,
        runners: Array.isArray(r.runners)
          ? (r.runners as Array<Record<string, unknown>>).map((x) => ({
              runner_id: x.runner_id ?? null,
              horse_no: x.horse_no,
              win_odds: x.win_odds,
              place_odds: x.place_odds,
              status: x.status,
              final_position: x.final_position,
            }))
          : [],
      }))
    : [];
  return {
    schema: envelope.schema,
    event: envelope.event,
    meeting_date: envelope.meeting_date,
    venue: envelope.venue,
    races,
    changes,
    pools: envelope.pools ?? null,
    last_change_seq: envelope.last_change_seq ?? null,
  };
}

function parseRows(raw: unknown): EventRow[] {
  if (Array.isArray(raw)) return raw as EventRow[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results)) {
    return (raw as { results: EventRow[] }).results;
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as { events?: unknown }).events)) {
    return (raw as { events: EventRow[] }).events;
  }
  return [];
}

function analyze(rows: EventRow[]): {
  total: number;
  byEvent: Record<string, number>;
  emptyDelta: number;
  duplicateStableBodies: number;
  uniqueStableBodies: number;
  windowMinutes: number | null;
} {
  const byEvent: Record<string, number> = {};
  const seen = new Map<string, number>();
  let emptyDelta = 0;
  let duplicateStableBodies = 0;
  let times: number[] = [];

  for (const row of rows) {
    let envelope: Record<string, unknown> | null = null;
    if (row.payload_json) {
      try {
        envelope = JSON.parse(row.payload_json) as Record<string, unknown>;
      } catch {
        envelope = null;
      }
    } else if (row.payload && typeof row.payload === "object") {
      envelope = row.payload as Record<string, unknown>;
    }

    const event =
      (envelope?.event as string | undefined) ??
      row.event_type ??
      row.event ??
      "unknown";
    byEvent[event] = (byEvent[event] ?? 0) + 1;

    if (event === "odds_delta") {
      const changes = envelope?.changes;
      if (!Array.isArray(changes) || changes.length === 0) emptyDelta++;
    }

    const ts = row.created_at ?? row.sent_at ?? (envelope?.sent_at as string | undefined);
    if (ts) {
      const ms = Date.parse(ts);
      if (Number.isFinite(ms)) times.push(ms);
    }

    if (envelope) {
      const hash = sha256Hex(canonicalize(stableBody(envelope)));
      const n = (seen.get(hash) ?? 0) + 1;
      seen.set(hash, n);
      if (n > 1) duplicateStableBodies++;
    } else if (row.payload_hash) {
      const n = (seen.get(row.payload_hash) ?? 0) + 1;
      seen.set(row.payload_hash, n);
      if (n > 1) duplicateStableBodies++;
    }
  }

  times.sort((a, b) => a - b);
  const windowMinutes =
    times.length >= 2 ? (times[times.length - 1]! - times[0]!) / 60_000 : null;

  return {
    total: rows.length,
    byEvent,
    emptyDelta,
    duplicateStableBodies,
    uniqueStableBodies: seen.size,
    windowMinutes,
  };
}

function printEstimate(): void {
  console.log("\n=== Expected hourly volume AFTER fixes ===\n");
  console.log("Off-window (outside race-day high-freq / non-race day):");
  console.log(
    `  - heartbeat (odds_update or no_update): ~${OFFWINDOW_HEARTBEAT_PER_HOUR}/h (every 30 min)`,
  );
  console.log(
    `  - odds_delta: 0–${OFFWINDOW_DELTA_CAP_PER_HOUR}/h cap (coalesce ${DEFAULT_OFFWINDOW_COALESCE}s; only real odds moves vs last-pushed)`,
  );
  console.log(
    `  - full odds_update outside heartbeat: 0 (suppressed)`,
  );
  console.log(
    `  - typical quiet off-window: ~${OFFWINDOW_HEARTBEAT_PER_HOUR} events/h`,
  );
  console.log(
    `  - busy off-window (odds drifting): ~${OFFWINDOW_HEARTBEAT_PER_HOUR + OFFWINDOW_DELTA_CAP_PER_HOUR} events/h max`,
  );

  console.log("\nIn-window (race-day high-freq: first_post-2h → final dividends):");
  console.log(
    `  - heartbeat / merged snapshot: ~${INWINDOW_HEARTBEAT_PER_HOUR}/h (every 5 min)`,
  );
  console.log(
    `  - periodic full odds_update: ~${INWINDOW_FULL_SNAPSHOT_PER_HOUR}/h (often merged with heartbeat)`,
  );
  console.log(
    `  - odds_delta: 0–${INWINDOW_DELTA_CAP_PER_HOUR}/h theoretical cap (2s coalesce); real volume = distinct odds moves only`,
  );
  console.log(
    `  - typical active betting: tens–low hundreds of deltas/h + ~12 snapshots/h`,
  );
  console.log(
    `\nIncident reference (740b52d3, ~8 min off-window before 10-14 HV):`,
  );
  console.log(
    `  observed: 7 odds_delta + 2 odds_update + 1 source_recovered`,
  );
  console.log(
    `  expected after fix for same quiet off-window slice: ≤1 odds_update/no_update, 0 empty/dup deltas`,
  );
}

const DEFAULT_OFFWINDOW_COALESCE = 300;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--estimate-only") || args.length === 0) {
    printEstimate();
    if (args.length === 0) {
      console.log(
        "\n(Pass --from-json <file> or --api to analyze stored pushes; --estimate-only for volume only.)",
      );
    }
    return;
  }

  let rows: EventRow[] = [];

  if (args.includes("--from-json")) {
    const idx = args.indexOf("--from-json");
    const path = args[idx + 1];
    if (!path) throw new Error("--from-json requires a path");
    rows = parseRows(JSON.parse(readFileSync(path, "utf8")));
  } else if (args.includes("--api")) {
    const base = process.env.BASE_URL ?? "http://127.0.0.1:8787";
    const token = process.env.API_TOKEN ?? "";
    const res = await fetch(`${base}/v1/events?limit=500`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      console.error("API failed", res.status, await res.text());
      process.exit(1);
    }
    const body = (await res.json()) as { events?: EventRow[]; results?: EventRow[] };
    rows = parseRows(body.events ?? body.results ?? body);
  } else {
    console.error("Usage: --estimate-only | --from-json <file> | --api");
    process.exit(2);
  }

  const stats = analyze(rows);
  console.log("=== push dedupe dry-run ===");
  console.log(`rows: ${stats.total}`);
  if (stats.windowMinutes != null) {
    console.log(`span: ${stats.windowMinutes.toFixed(1)} min`);
  }
  console.log("by event:", stats.byEvent);
  console.log(`empty odds_delta (changes[]): ${stats.emptyDelta}`);
  console.log(`unique stable bodies: ${stats.uniqueStableBodies}`);
  console.log(
    `duplicate stable bodies (would be suppressed): ${stats.duplicateStableBodies}`,
  );
  printEstimate();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
