CREATE TABLE "product_proposal_audit" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"content_sha256" text NOT NULL,
	"content_length" integer NOT NULL,
	"proposed_by" text NOT NULL,
	"attempt_id" text NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "product_proposal_audit_tenant_id_project_id_proposal_id_pk" PRIMARY KEY("tenant_id","project_id","proposal_id"),
	CONSTRAINT "product_proposal_audit_outcome" CHECK ("product_proposal_audit"."outcome" IN ('pending', 'used', 'dropped'))
);
--> statement-breakpoint
ALTER TABLE "product_proposal_audit" ADD CONSTRAINT "product_proposal_audit_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;