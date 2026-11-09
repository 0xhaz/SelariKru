ALTER TABLE "attempts" ADD COLUMN "last_tool" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "last_tool_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "last_seen_at" timestamp with time zone;