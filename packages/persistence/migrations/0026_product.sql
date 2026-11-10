CREATE TABLE "product_heads" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_heads_tenant_id_project_id_pk" PRIMARY KEY("tenant_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "product_records" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"record_id" text NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"classification" text NOT NULL,
	"content" jsonb NOT NULL,
	"proposed_by_kind" text NOT NULL,
	"proposed_by" text NOT NULL,
	"confirmed_by" text,
	"seq" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "product_records_tenant_id_project_id_record_id_revision_pk" PRIMARY KEY("tenant_id","project_id","record_id","revision"),
	CONSTRAINT "product_records_kind" CHECK ("product_records"."kind" IN ('problem_brief', 'outcome_plan', 'release_note', 'outcome_review')),
	CONSTRAINT "product_records_status" CHECK ("product_records"."status" IN ('proposed', 'confirmed', 'recorded')),
	CONSTRAINT "product_records_classification" CHECK ("product_records"."classification" IN ('public', 'internal', 'restricted', 'secret')),
	CONSTRAINT "product_records_proposer" CHECK ("product_records"."proposed_by_kind" IN ('human', 'worker')),
	CONSTRAINT "product_records_confirmed" CHECK (("product_records"."status" = 'confirmed') = ("product_records"."confirmed_by" IS NOT NULL) AND ("product_records"."proposed_by_kind" = 'human' OR "product_records"."status" = 'proposed'))
);
--> statement-breakpoint
ALTER TABLE "brain_sources" DROP CONSTRAINT "brain_sources_kind";--> statement-breakpoint
ALTER TABLE "product_heads" ADD CONSTRAINT "product_heads_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_records" ADD CONSTRAINT "product_records_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_records_seq" ON "product_records" USING btree ("tenant_id","project_id","seq");--> statement-breakpoint
ALTER TABLE "brain_sources" ADD CONSTRAINT "brain_sources_kind" CHECK ("brain_sources"."kind" IN ('brief', 'criteria', 'plan', 'decision', 'verification', 'repo_manifest', 'note', 'stack', 'product'));--> statement-breakpoint
CREATE FUNCTION product_records_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a product record revision is immutable; write a new revision instead';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER product_records_no_update_or_delete BEFORE UPDATE OR DELETE ON "product_records" FOR EACH ROW EXECUTE FUNCTION product_records_immutable();
