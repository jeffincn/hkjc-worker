import type { Env } from "../env";
import { setMeta } from "../store/db";

export type IngestStage =
  | "schedule"
  | "odds"
  | "dividends"
  | "horses"
  | "runs"
  | "injuries"
  | "pushes"
  | "changes"
  | "persist"
  | "wake_do"
  | "retry_flush"
  | "backfill"
  | "watchdog";

export function stageErrorKey(stage: IngestStage): string {
  return `stage_error_${stage}`;
}

export function stageOkKey(stage: IngestStage): string {
  return `stage_ok_at_${stage}`;
}

/**
 * Run an ingest/poll stage in isolation. Failures are recorded to worker_meta
 * and never abort sibling stages.
 */
export async function runStage<T>(
  env: Env,
  stage: IngestStage,
  fn: () => Promise<T>,
  opts?: { onError?: (err: unknown) => void },
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const value = await fn();
    await setMeta(env.DB, stageErrorKey(stage), "");
    await setMeta(env.DB, stageOkKey(stage), new Date().toISOString());
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[stage:${stage}]`, message, err);
    try {
      await setMeta(env.DB, stageErrorKey(stage), message.slice(0, 500));
    } catch (metaErr) {
      console.error(`[stage:${stage}] failed to record error`, metaErr);
    }
    opts?.onError?.(err);
    return { ok: false, error: message };
  }
}

export async function readStageErrors(
  env: Env,
  stages: IngestStage[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const stage of stages) {
    const row = await env.DB.prepare(`SELECT value FROM worker_meta WHERE key=?`)
      .bind(stageErrorKey(stage))
      .first<{ value: string }>();
    const v = row?.value ?? null;
    out[stage] = v && v.length > 0 ? v : null;
  }
  return out;
}
