CREATE TABLE "model_assignments" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"revision" integer NOT NULL,
	"provider" text,
	"model" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_assignments_tenant_id_project_id_scope_kind_scope_key_revision_pk" PRIMARY KEY("tenant_id","project_id","scope_kind","scope_key","revision"),
	CONSTRAINT "model_assignments_scope_kind" CHECK (scope_kind IN ('role', 'task')),
	CONSTRAINT "model_assignments_provider_model_paired" CHECK ((provider IS NULL) = (model IS NULL))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pinned_model" jsonb;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "model_provider" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "assignment_source" text;