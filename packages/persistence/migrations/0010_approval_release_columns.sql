ALTER TABLE "approvals" ADD COLUMN "detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "consumed_by" text;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_pending_key" ON "approvals" USING btree ("tenant_id","project_id","task_id","revision","scope_hash") WHERE outcome = 'pending' AND task_id IS NOT NULL;