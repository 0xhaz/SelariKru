CREATE TABLE "agent_contexts" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"context_id" text NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"destination" text NOT NULL,
	"content_label" text NOT NULL,
	"served_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_contexts_tenant_id_project_id_context_id_pk" PRIMARY KEY("tenant_id","project_id","context_id"),
	CONSTRAINT "agent_contexts_destination" CHECK ("agent_contexts"."destination" IN ('local', 'cloud'))
);
--> statement-breakpoint
ALTER TABLE "agent_contexts" ADD CONSTRAINT "agent_contexts_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;