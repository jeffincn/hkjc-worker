-- HKJC brand horse code (e.g. H087) on runners / results.
-- Source: GraphQL runner.horse.code (already polled). Nullable for backfill/rbc gaps.
-- horses.horse_code remains the profile PK; stubs may be inserted from meeting tree.

ALTER TABLE runners ADD COLUMN horse_code TEXT;
ALTER TABLE results ADD COLUMN horse_code TEXT;

CREATE INDEX IF NOT EXISTS idx_runners_horse_code ON runners (horse_code);
CREATE INDEX IF NOT EXISTS idx_runners_lookup_code
  ON runners (meeting_date, venue, race_no, horse_no);
