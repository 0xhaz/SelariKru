CREATE TABLE "project_stacks" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"catalog_version" text NOT NULL,
	"document" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_stacks_tenant_id_project_id_pk" PRIMARY KEY("tenant_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "brain_sources" DROP CONSTRAINT "brain_sources_kind";--> statement-breakpoint
ALTER TABLE "project_stacks" ADD CONSTRAINT "project_stacks_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_sources" ADD CONSTRAINT "brain_sources_kind" CHECK ("brain_sources"."kind" IN ('brief', 'criteria', 'plan', 'decision', 'verification', 'repo_manifest', 'note', 'stack'));