ALTER TABLE "runs" ADD COLUMN "placement" jsonb;--> statement-breakpoint
ALTER TABLE "task_status" ADD COLUMN "placement_block" text;