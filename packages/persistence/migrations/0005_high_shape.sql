CREATE TABLE "client_reports" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"report_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"kind" text NOT NULL,
	"trust" text DEFAULT 'untrusted' NOT NULL,
	"payload" jsonb NOT NULL,
	"reported_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_reports_tenant_id_project_id_report_id_pk" PRIMARY KEY("tenant_id","project_id","report_id"),
	CONSTRAINT "client_reports_untrusted" CHECK ("client_reports"."trust" = 'untrusted')
);
--> statement-breakpoint
CREATE TABLE "runner_pairing_codes" (
	"tenant_id" text NOT NULL,
	"code_hash" text PRIMARY KEY NOT NULL,
	"location" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"runner_id" text,
	CONSTRAINT "runner_pairing_codes_location" CHECK ("runner_pairing_codes"."location" IN ('local', 'cloud'))
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"tenant_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"location" text NOT NULL,
	"label" text,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "runners_tenant_id_runner_id_pk" PRIMARY KEY("tenant_id","runner_id"),
	CONSTRAINT "runners_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "runners_location" CHECK ("runners"."location" IN ('local', 'cloud'))
);
--> statement-breakpoint
CREATE TABLE "task_commands" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"command" text NOT NULL,
	"state" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "task_commands_tenant_id_project_id_operation_id_pk" PRIMARY KEY("tenant_id","project_id","operation_id")
);
--> statement-breakpoint
ALTER TABLE "client_reports" ADD CONSTRAINT "client_reports_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_commands" ADD CONSTRAINT "task_commands_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;