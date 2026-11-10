CREATE TABLE "skill_actions" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"seq" serial NOT NULL,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"skill_id" text NOT NULL,
	"version_id" text,
	"before" jsonb,
	"after" jsonb,
	CONSTRAINT "skill_actions_tenant_id_project_id_seq_pk" PRIMARY KEY("tenant_id","project_id","seq"),
	CONSTRAINT "skill_actions_kind" CHECK (kind IN ('intake', 'review', 'revoke', 'bind', 'unbind'))
);
--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "skill_delivery" boolean;--> statement-breakpoint
ALTER TABLE "skill_execution_records" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skill_execution_records" ADD COLUMN "confirmed" jsonb;