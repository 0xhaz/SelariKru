CREATE TABLE "task_settings" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text NOT NULL,
	"field" text NOT NULL,
	"desired" jsonb NOT NULL,
	"desired_revision" integer NOT NULL,
	"effective" jsonb,
	"effective_revision" integer DEFAULT 0 NOT NULL,
	"enforcer" text NOT NULL,
	"config_revision" integer,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "task_settings_tenant_id_project_id_task_id_field_pk" PRIMARY KEY("tenant_id","project_id","task_id","field"),
	CONSTRAINT "task_settings_field" CHECK (field IN ('route_override')),
	CONSTRAINT "task_settings_enforcer" CHECK (enforcer IN ('server', 'runner'))
);
--> statement-breakpoint
ALTER TABLE "run_settings" DROP CONSTRAINT "run_settings_field";--> statement-breakpoint
ALTER TABLE "task_settings" ADD CONSTRAINT "task_settings_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_settings" ADD CONSTRAINT "run_settings_field" CHECK (field IN ('paused', 'budget_limit_usd', 'allowed_paths', 'cloud_eligible', 'route_policy'));