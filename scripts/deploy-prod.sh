#!/usr/bin/env bash
# Production deploy helper.
#
# The committed wrangler.toml is a sanitized template: database_id is a
# placeholder and LIVE_PUSH_ENABLED=false (safe for local dev). At deploy
# time this script injects the real values into the (ephemeral) checkout,
# then deploys. The repo itself never carries the real database id.
#
# Required env: D1_DATABASE_ID  (Cloudflare build variable / CI secret)
# Cloudflare auth: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or the
# Workers Builds built-in credentials.
set -euo pipefail

: "${D1_DATABASE_ID:?D1_DATABASE_ID is not set (Cloudflare build variable or CI secret)}"

PLACEHOLDER="00000000-0000-0000-0000-000000000000"
if ! grep -q "$PLACEHOLDER" wrangler.toml; then
  echo "wrangler.toml does not contain the placeholder database_id; refusing to deploy" >&2
  exit 1
fi

sed -i "s/${PLACEHOLDER}/${D1_DATABASE_ID}/" wrangler.toml
sed -i 's/^LIVE_PUSH_ENABLED = "false"/LIVE_PUSH_ENABLED = "true"/' wrangler.toml

echo "Deploying hkjc-data-worker (D1 id injected, LIVE_PUSH_ENABLED=true)..."
npx wrangler deploy
