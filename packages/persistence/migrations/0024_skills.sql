CREATE TABLE "project_skill_bindings" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"skill_id" text NOT NULL,
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
	CONSTRAINT "project_skill_bindings_tenant_id_project_id_skill_id_pk" PRIMARY KEY("tenant_id","project_id","skill_id"),
	CONSTRAINT "project_skill_bindings_field" CHECK (field = 'binding'),
	CONSTRAINT "project_skill_bindings_enforcer" CHECK (enforcer = 'server')
);
--> statement-breakpoint
CREATE TABLE "skill_evaluations" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"evaluation_id" text NOT NULL,
	"version_id" text NOT NULL,
	"record" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_evaluations_tenant_id_project_id_evaluation_id_pk" PRIMARY KEY("tenant_id","project_id","evaluation_id")
);
--> statement-breakpoint
CREATE TABLE "skill_execution_records" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"task_id" text NOT NULL,
	"record" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_execution_records_tenant_id_project_id_attempt_id_pk" PRIMARY KEY("tenant_id","project_id","attempt_id")
);
--> statement-breakpoint
CREATE TABLE "skill_pack_files" (
	"tenant_id" text NOT NULL,
	"version_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "skill_pack_files_tenant_id_version_id_path_pk" PRIMARY KEY("tenant_id","version_id","path")
);
--> statement-breakpoint
CREATE TABLE "skill_revocations" (
	"tenant_id" text NOT NULL,
	"version_id" text NOT NULL,
	"reason" text NOT NULL,
	"revoked_by" text NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_revocations_tenant_id_version_id_pk" PRIMARY KEY("tenant_id","version_id")
);
--> statement-breakpoint
CREATE TABLE "skill_staged_versions" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"version_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"version" jsonb NOT NULL,
	"scan" jsonb NOT NULL,
	"blocked" boolean NOT NULL,
	"staged_by" text NOT NULL,
	"staged_at" timestamp with time zone NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "skill_staged_versions_tenant_id_version_id_pk" PRIMARY KEY("tenant_id","version_id")
);
--> statement-breakpoint
ALTER TABLE "skill_staged_versions" ADD CONSTRAINT "skill_staged_versions_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;