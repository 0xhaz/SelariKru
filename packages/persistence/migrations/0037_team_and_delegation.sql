CREATE TABLE "task_delegations" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"run_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"plan_revision" integer NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_delegations_tenant_id_project_id_task_id_revision_pk" PRIMARY KEY("tenant_id","project_id","task_id","revision"),
	CONSTRAINT "task_delegations_actor" CHECK ("task_delegations"."actor_kind" IN ('agent', 'human'))
);
--> statement-breakpoint
ALTER TABLE "run_settings" DROP CONSTRAINT "run_settings_field";--> statement-breakpoint
ALTER TABLE "runner_settings" DROP CONSTRAINT "runner_settings_field";--> statement-breakpoint
ALTER TABLE "task_delegations" ADD CONSTRAINT "task_delegations_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_settings" ADD CONSTRAINT "run_settings_field" CHECK (field IN ('paused', 'budget_limit_usd', 'allowed_paths', 'cloud_eligible', 'route_policy', 'auto_delegate'));--> statement-breakpoint
ALTER TABLE "runner_settings" ADD CONSTRAINT "runner_settings_field" CHECK (field IN ('enabled', 'slots', 'display_name', 'role'));