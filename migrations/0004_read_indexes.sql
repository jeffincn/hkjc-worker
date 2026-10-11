-- 0004: read-budget indexes.
--
-- /v1/changes polls `odds_snapshots` by created_at every 30s (push-watch hook).
-- Without an index that query is a full table scan on every poll, which burned
-- through the D1 free-tier daily row-read quota on race day 2026-10-11 (all
-- query endpoints, including /health, started returning 500 D1_ERROR).
-- An index turns it into a bounded range scan.
CREATE INDEX IF NOT EXISTS idx_odds_created_at ON odds_snapshots (created_at);
