CREATE TABLE "run_settings" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
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
	CONSTRAINT "run_settings_tenant_id_project_id_run_id_field_pk" PRIMARY KEY("tenant_id","project_id","run_id","field"),
	CONSTRAINT "run_settings_field" CHECK (field IN ('paused', 'budget_limit_usd', 'allowed_paths', 'cloud_eligible')),
	CONSTRAINT "run_settings_enforcer" CHECK (enforcer IN ('server', 'runner'))
);
--> statement-breakpoint
CREATE TABLE "runner_config" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_settings" (
	"tenant_id" text NOT NULL,
	"runner_id" text NOT NULL,
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
	"event_project_id" text NOT NULL,
	"event_run_id" text NOT NULL,
	CONSTRAINT "runner_settings_tenant_id_runner_id_field_pk" PRIMARY KEY("tenant_id","runner_id","field"),
	CONSTRAINT "runner_settings_field" CHECK (field IN ('enabled', 'slots')),
	CONSTRAINT "runner_settings_enforcer" CHECK (enforcer IN ('server', 'runner'))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_by" text;--> statement-breakpoint
ALTER TABLE "model_assignments" ADD COLUMN "config_revision" integer;--> statement-breakpoint
ALTER TABLE "model_assignments" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "config_ack_revision" integer;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "config_ack_slots" integer;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "config_ack_at" timestamp with time zone;