CREATE TABLE "change_requests" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"repository" text NOT NULL,
	"candidate_sha" text NOT NULL,
	"branch" text NOT NULL,
	"base_ref" text NOT NULL,
	"pr_number" integer NOT NULL,
	"url" text NOT NULL,
	"status" text NOT NULL,
	"observed_head_sha" text,
	"merge_commit_sha" text,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_requests_tenant_id_project_id_run_id_pk" PRIMARY KEY("tenant_id","project_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "integration_deliveries" ALTER COLUMN "sequence" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_tenant_id_project_id_run_id_runs_tenant_id_project_id_run_id_fk" FOREIGN KEY ("tenant_id","project_id","run_id") REFERENCES "public"."runs"("tenant_id","project_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_requests_pr_key" ON "change_requests" USING btree ("tenant_id","project_id","pr_number");