ALTER TABLE "checkpoints" DROP CONSTRAINT "checkpoints_state";--> statement-breakpoint
DROP INDEX "checkpoints_one_open";--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "diffs" jsonb;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "content_dropped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "content_dropped_reason" text;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "released_by" text;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "successor_retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "closed_reason" text;--> statement-breakpoint
UPDATE "checkpoints" c SET "state" = 'closed', "closed_reason" = 'successor_ended' WHERE c."state" IN ('starting', 'running') AND EXISTS (SELECT 1 FROM "checkpoints" o WHERE o."tenant_id" = c."tenant_id" AND o."project_id" = c."project_id" AND o."task_id" = c."task_id" AND o."state" IN ('stopping', 'fenced', 'starting', 'running', 'restart_offered') AND (o."requested_at", o."checkpoint_id") > (c."requested_at", c."checkpoint_id"));--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoints_one_open" ON "checkpoints" USING btree ("tenant_id","project_id","task_id") WHERE "checkpoints"."state" IN ('stopping', 'awaiting_review', 'fenced', 'starting', 'running', 'restart_offered');--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_state" CHECK ("checkpoints"."state" IN ('stopping', 'awaiting_review', 'fenced', 'starting', 'running', 'restart_offered', 'declined', 'closed'));