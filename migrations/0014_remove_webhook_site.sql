-- Remove webhook.site push subscribers (no longer used as receivers / seeds).
-- Do not edit 0003_push_subscribers.sql history; this migration cleans up
-- rows that may still exist from that seed (or later admin inserts).

-- Drop pending deliveries aimed at webhook.site subscribers first.
DELETE FROM pending_pushes
WHERE subscriber_id IN (
  SELECT id FROM push_subscribers WHERE url LIKE 'https://webhook.site/%'
);

DELETE FROM push_subscribers
WHERE url LIKE 'https://webhook.site/%';

-- Orphan pending rows whose subscriber was already deleted (or never existed).
DELETE FROM pending_pushes
WHERE subscriber_id IS NOT NULL
  AND subscriber_id NOT IN (SELECT id FROM push_subscribers);
