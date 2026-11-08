ALTER TABLE "attempts" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "last_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "outcome" text;--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_task_revision_fence_key" ON "attempts" USING btree ("tenant_id","project_id","task_id","revision","lease_fence") WHERE lease_fence IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_one_active_lease" ON "attempts" USING btree ("tenant_id","project_id","task_id") WHERE lease_token IS NOT NULL AND ended_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_claims_one_active_exclusive" ON "resource_claims" USING btree ("tenant_id","project_id","resource_key") WHERE mode = 'exclusive' AND released_at IS NULL;