import { handleApi } from "./api/router";
import type { Env } from "./env";
import { runBackfillStep } from "./backfill/runner";
import { ingestActiveMeeting } from "./services/ingest";
import { flushDueRetries } from "./push/pusher";

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
    // Hourly cron (wrangler): daily schedule check + polite backfill step + retry flush.
    // High-frequency odds polling is handled by MeetingPoller Durable Object alarms.
    ctx.waitUntil(
      (async () => {
        await flushDueRetries(env);
        await ingestActiveMeeting(env);
        // Small backfill step each cron tick (resumable)
        if ((env.BACKFILL_SOURCE ?? "graphql") !== "off") {
          await runBackfillStep(env, { limit: 2 });
        }
        void controller;
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
