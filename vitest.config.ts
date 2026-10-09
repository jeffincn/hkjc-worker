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
            POLL_INTERVAL_SEC: "30",
            // No PUSH_TARGET_URL — tests must not hit real webhooks
          },
        },
      },
    },
  },
});
