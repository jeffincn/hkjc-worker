import type { Env } from "../env";
import { envNum } from "../env";
import { setMeta } from "../store/db";

const DEFAULT_STALE_MS = 10 * 60 * 1000;

interface DoStatus {
  cfg?: { meeting_date?: string; venue?: string } | null;
  alarm?: number | null;
  last_fetch_at?: string | null;
}

/**
 * Hourly cron watchdog: if a MeetingPoller alarm is missing or last tick is
 * stale, re-arm via /start. Never throws.
 */
export async function rearmStalePollers(
  env: Env,
  meetings: Array<{ date: string; venue: string }>,
): Promise<{ checked: number; rearmed: number }> {
  const staleMs = envNum(env, "POLLER_STALE_MS", DEFAULT_STALE_MS);
  let checked = 0;
  let rearmed = 0;
  const now = Date.now();

  for (const m of meetings) {
    checked++;
    try {
      const id = env.MEETING_DO.idFromName(`${m.date}_${m.venue}`);
      const stub = env.MEETING_DO.get(id);
      const statusRes = await stub.fetch("https://do/status");
      const status = (await statusRes.json()) as DoStatus;
      const lastFetchMs = status.last_fetch_at ? Date.parse(status.last_fetch_at) : NaN;
      const alarmMissing = status.alarm == null;
      const tickStale =
        !Number.isFinite(lastFetchMs) || now - lastFetchMs > staleMs;

      if (alarmMissing || tickStale) {
        await stub.fetch("https://do/start", {
          method: "POST",
          body: JSON.stringify({ meeting_date: m.date, venue: m.venue }),
        });
        rearmed++;
        await setMeta(
          env.DB,
          "poller_watchdog_last_rearm",
          JSON.stringify({
            at: new Date().toISOString(),
            meeting_date: m.date,
            venue: m.venue,
            reason: alarmMissing ? "alarm_missing" : "tick_stale",
          }),
        );
      }
    } catch (err) {
      console.error("watchdog rearm failed", m, err);
      try {
        await setMeta(
          env.DB,
          "stage_error_watchdog",
          err instanceof Error ? err.message : String(err),
        );
      } catch {
        // ignore
      }
    }
  }

  await setMeta(env.DB, "poller_watchdog_last_run", new Date().toISOString());
  return { checked, rearmed };
}
