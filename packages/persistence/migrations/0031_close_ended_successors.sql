-- A successor row left starting or running after its attempt ended (code before T6.7 fix round 1 did not close it) holds the task for nothing: close it, and drop what it kept.
UPDATE "checkpoints" c SET "state" = 'closed', "closed_reason" = 'successor_ended', "content" = NULL, "diffs" = NULL,
  "content_dropped_at" = CASE WHEN c."content" IS NOT NULL THEN now() ELSE c."content_dropped_at" END,
  "content_dropped_reason" = CASE WHEN c."content" IS NOT NULL THEN 'successor_ended' ELSE c."content_dropped_reason" END,
  "updated_at" = now()
WHERE c."state" IN ('starting', 'running') AND (c."successor_attempt_id" IS NULL OR EXISTS (
  SELECT 1 FROM "attempts" a WHERE a."tenant_id" = c."tenant_id" AND a."project_id" = c."project_id" AND a."attempt_id" = c."successor_attempt_id" AND a."ended_at" IS NOT NULL));
