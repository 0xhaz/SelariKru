CREATE TABLE "candidates" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"run_id" text NOT NULL,
	"target" text NOT NULL,
	"sha" text,
	"base_sha" text NOT NULL,
	"tree_sha" text,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_tenant_id_project_id_candidate_id_pk" PRIMARY KEY("tenant_id","project_id","candidate_id")
);
--> statement-breakpoint
CREATE TABLE "integration_leases" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"target" text NOT NULL,
	"holder" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "integration_leases_tenant_id_project_id_target_pk" PRIMARY KEY("tenant_id","project_id","target")
);
--> statement-breakpoint
CREATE TABLE "plan_proposals" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"run_id" text NOT NULL,
	"based_on_plan_revision" integer NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"candidate_id" text,
	"tasks" jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_proposals_tenant_id_project_id_proposal_id_pk" PRIMARY KEY("tenant_id","project_id","proposal_id")
);
--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_tenant_id_project_id_run_id_runs_tenant_id_project_id_run_id_fk" FOREIGN KEY ("tenant_id","project_id","run_id") REFERENCES "public"."runs"("tenant_id","project_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_proposals" ADD CONSTRAINT "plan_proposals_tenant_id_project_id_run_id_runs_tenant_id_project_id_run_id_fk" FOREIGN KEY ("tenant_id","project_id","run_id") REFERENCES "public"."runs"("tenant_id","project_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_run_sha_key" ON "candidates" USING btree ("tenant_id","project_id","run_id","sha") WHERE sha IS NOT NULL;