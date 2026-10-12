import { handleApi } from "./api/router";
import type { Env } from "./env";
import { runBackfillStep } from "./backfill/runner";
import { ingestActiveMeeting } from "./services/ingest";
import { handlePushQueueBatch, type PushDeliveryMessage } from "./push/queue";
import { runStage } from "./util/stage";

export { MeetingPoller } from "./poll/meeting-do";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleApi(request, env);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Hourly cron: schedule ingest + watchdog re-arm + polite backfill.
    // High-frequency odds polling is handled by MeetingPoller Durable Object alarms.
    // Push HTTP delivery runs in the Queue consumer (or direct fallback).
    ctx.waitUntil(
      (async () => {
        await runStage(env, "schedule", async () => {
          await ingestActiveMeeting(env);
        });
        if ((env.BACKFILL_SOURCE ?? "graphql") !== "off") {
          await runStage(env, "backfill", async () => {
            await runBackfillStep(env, { limit: 2 });
          });
        }
        void controller;
      })(),
    );
  },

  /**
   * Cloudflare Queue consumer: each message is one (event_id, subscriber)
   * delivery with its own subrequest budget. Absent PUSH_QUEUE binding →
   * this handler is never invoked (tests/local use direct send).
   */
  async queue(
    batch: MessageBatch<PushDeliveryMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await handlePushQueueBatch(batch, env);
  },
} satisfies ExportedHandler<Env, PushDeliveryMessage>;
