CREATE TABLE "product_brief_proposals" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"classification" text NOT NULL,
	"proposed_by" text NOT NULL,
	"attempt_id" text NOT NULL,
	"seq" integer NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "product_brief_proposals_tenant_id_project_id_proposal_id_pk" PRIMARY KEY("tenant_id","project_id","proposal_id"),
	CONSTRAINT "product_brief_proposals_classification" CHECK ("product_brief_proposals"."classification" IN ('public', 'internal', 'restricted', 'secret'))
);
--> statement-breakpoint
ALTER TABLE "product_heads" ADD COLUMN "evented_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_heads" ADD COLUMN "dropped_proposals" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_heads" ADD COLUMN "proposal_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_records" ADD COLUMN "event_detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "product_brief_proposals" ADD CONSTRAINT "product_brief_proposals_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "product_heads" SET "evented_seq" = "last_seq";