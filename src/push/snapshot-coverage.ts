import type { Env } from "../env";
import type { RaceOddsSnapshot } from "../parse/odds";
import {
  buildFullSnapshotCoverageMeta,
  withRaceSourceTs,
  type FullSnapshotCoverageMeta,
} from "./delta";
import type { PushRace, PushRunner } from "./envelope";
import { getLatestOddsSnapshot } from "../store/db";

export function snapshotToPushRace(snap: RaceOddsSnapshot): PushRace {
  return {
    race_no: snap.race_no,
    post_time: snap.post_time,
    snapshot_time: snap.snapshot_time,
    pool_status: snap.pool_status,
    source_last_updated_at: snap.payload.last_update,
    runners: snap.runners.map(
      (r): PushRunner => ({
        runner_id: r.runner_id,
        horse_no: r.horse_no,
        horse_name: r.horse_name,
        win_odds: r.win_odds,
        place_odds: r.place_odds,
        status: r.status,
        final_position: r.final_position,
      }),
    ),
  };
}

/**
 * Build a meeting-complete odds_update races[]:
 * 1) prefer live `available` snapshots from this tick,
 * 2) fill gaps from D1 latest snapshot when a card race was dropped
 *    (e.g. transient empty pre-sale / not in changed set).
 */
export async function buildCompleteSnapshotRaces(args: {
  env: Env;
  meeting_date: string;
  venue: string;
  expectedRaceNos: number[];
  available: PushRace[];
}): Promise<{ races: PushRace[]; meta: FullSnapshotCoverageMeta }> {
  const byNo = new Map<number, PushRace>();
  for (const r of withRaceSourceTs(args.available)) {
    byNo.set(r.race_no, r);
  }

  for (const raceNo of args.expectedRaceNos) {
    if (byNo.has(raceNo)) continue;
    const snap = await getLatestOddsSnapshot(
      args.env.DB,
      args.meeting_date,
      args.venue,
      raceNo,
    );
    if (!snap) continue;
    byNo.set(raceNo, withRaceSourceTs([snapshotToPushRace(snap)])[0]!);
  }

  const races = [...byNo.values()].sort((a, b) => a.race_no - b.race_no);
  const meta = buildFullSnapshotCoverageMeta({
    expectedRaceNos: args.expectedRaceNos,
    races,
  });
  return { races, meta };
}
