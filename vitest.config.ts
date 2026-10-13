import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: false,
    setupFiles: ["./test/apply-migrations.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            API_TOKEN: "test-api-token",
            LIVE_PUSH_ENABLED: "false",
            BACKFILL_DAYS: "60",
            BACKFILL_SOURCE: "graphql",
            TIMEZONE: "Asia/Hong_Kong",
            POLL_INTERVAL_MS: "3000",
            DAILY_REQUEST_BUDGET: "30000",
            // High defaults so existing multi-send tests stay one-by-one;
            // dedicated rate-limit / coalesce suites override these.
            PUSH_RATE_PER_SUB_PER_SEC: "100",
            PUSH_BACKLOG_COALESCE_MIN: "999",
            // No PUSH_TARGET_URL — tests must not hit real webhooks
          },
        },
      },
    },
  },
});
