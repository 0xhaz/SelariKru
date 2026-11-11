CREATE TABLE "accepted_proposals" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"run_id" text NOT NULL,
	"base_sha" text NOT NULL,
	"route_record_id" text NOT NULL,
	"digest" text NOT NULL,
	"file_count" integer NOT NULL,
	"results" jsonb NOT NULL,
	"diff" text NOT NULL,
	"state" text NOT NULL,
	"attempt_id" text,
	"accepted_by" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "accepted_proposals_tenant_id_project_id_proposal_id_pk" PRIMARY KEY("tenant_id","project_id","proposal_id"),
	CONSTRAINT "accepted_proposals_state" CHECK ("accepted_proposals"."state" IN ('accepted', 'applying', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "accepted_proposals" ADD CONSTRAINT "accepted_proposals_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accepted_proposals_one_waiting" ON "accepted_proposals" USING btree ("tenant_id","project_id","task_id") WHERE "accepted_proposals"."state" = 'accepted';