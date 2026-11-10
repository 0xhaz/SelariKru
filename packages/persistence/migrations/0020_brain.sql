CREATE TABLE "brain_bundles" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"task_id" text NOT NULL,
	"destination" text NOT NULL,
	"compilation_version" integer,
	"bundle" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brain_bundles_tenant_id_project_id_attempt_id_pk" PRIMARY KEY("tenant_id","project_id","attempt_id"),
	CONSTRAINT "brain_bundles_destination" CHECK ("brain_bundles"."destination" IN ('local', 'cloud'))
);
--> statement-breakpoint
CREATE TABLE "brain_claim_supports" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"claim_id" text NOT NULL,
	"relation" text NOT NULL,
	"source_id" text NOT NULL,
	"revision" integer NOT NULL,
	"anchor" text NOT NULL,
	CONSTRAINT "brain_claim_supports_tenant_id_project_id_version_claim_id_relation_source_id_revision_anchor_pk" PRIMARY KEY("tenant_id","project_id","version","claim_id","relation","source_id","revision","anchor"),
	CONSTRAINT "brain_claim_supports_relation" CHECK ("brain_claim_supports"."relation" IN ('cites', 'rests_on', 'disputed_by'))
);
--> statement-breakpoint
CREATE TABLE "brain_compilations" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"generator_id" text NOT NULL,
	"generator_version" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"watermark" integer NOT NULL,
	"pages" jsonb NOT NULL,
	"conflicts" jsonb NOT NULL,
	CONSTRAINT "brain_compilations_tenant_id_project_id_version_pk" PRIMARY KEY("tenant_id","project_id","version")
);
--> statement-breakpoint
CREATE TABLE "brain_conflict_resolutions" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"conflict_id" text NOT NULL,
	"outcome" text NOT NULL,
	"resolved_by" text NOT NULL,
	"resolved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brain_conflict_resolutions_tenant_id_project_id_conflict_id_pk" PRIMARY KEY("tenant_id","project_id","conflict_id"),
	CONSTRAINT "brain_conflict_resolutions_outcome" CHECK ("brain_conflict_resolutions"."outcome" IN ('kept_accepted'))
);
--> statement-breakpoint
CREATE TABLE "brain_heads" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"compiled_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "brain_heads_tenant_id_project_id_pk" PRIMARY KEY("tenant_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "brain_revocations" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"source_id" text NOT NULL,
	"reason" text NOT NULL,
	"revoked_by" text NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "brain_revocations_tenant_id_project_id_source_id_pk" PRIMARY KEY("tenant_id","project_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "brain_sources" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"source_id" text NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"standing" text NOT NULL,
	"classification" text NOT NULL,
	"allowed_use" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"derived_from" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"task_id" text,
	"sections" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"seq" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brain_sources_tenant_id_project_id_source_id_revision_pk" PRIMARY KEY("tenant_id","project_id","source_id","revision"),
	CONSTRAINT "brain_sources_kind" CHECK ("brain_sources"."kind" IN ('brief', 'criteria', 'plan', 'decision', 'verification', 'repo_manifest', 'note')),
	CONSTRAINT "brain_sources_standing" CHECK ("brain_sources"."standing" IN ('accepted', 'proposed')),
	CONSTRAINT "brain_sources_classification" CHECK ("brain_sources"."classification" IN ('public', 'internal', 'restricted', 'secret'))
);
--> statement-breakpoint
ALTER TABLE "brain_bundles" ADD CONSTRAINT "brain_bundles_tenant_id_project_id_attempt_id_attempts_tenant_id_project_id_attempt_id_fk" FOREIGN KEY ("tenant_id","project_id","attempt_id") REFERENCES "public"."attempts"("tenant_id","project_id","attempt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_claim_supports" ADD CONSTRAINT "brain_claim_supports_tenant_id_project_id_version_brain_compilations_tenant_id_project_id_version_fk" FOREIGN KEY ("tenant_id","project_id","version") REFERENCES "public"."brain_compilations"("tenant_id","project_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_compilations" ADD CONSTRAINT "brain_compilations_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_conflict_resolutions" ADD CONSTRAINT "brain_conflict_resolutions_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_heads" ADD CONSTRAINT "brain_heads_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_revocations" ADD CONSTRAINT "brain_revocations_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_sources" ADD CONSTRAINT "brain_sources_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brain_sources_seq" ON "brain_sources" USING btree ("tenant_id","project_id","seq");--> statement-breakpoint
CREATE FUNCTION brain_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Project Brain history is immutable; record a new revision, revocation or compilation instead';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER brain_sources_immutable BEFORE UPDATE OR DELETE ON "brain_sources" FOR EACH ROW EXECUTE FUNCTION brain_immutable();
--> statement-breakpoint
CREATE TRIGGER brain_revocations_immutable BEFORE UPDATE OR DELETE ON "brain_revocations" FOR EACH ROW EXECUTE FUNCTION brain_immutable();
--> statement-breakpoint
CREATE TRIGGER brain_compilations_immutable BEFORE UPDATE OR DELETE ON "brain_compilations" FOR EACH ROW EXECUTE FUNCTION brain_immutable();
--> statement-breakpoint
CREATE TRIGGER brain_claim_supports_immutable BEFORE UPDATE OR DELETE ON "brain_claim_supports" FOR EACH ROW EXECUTE FUNCTION brain_immutable();
--> statement-breakpoint
CREATE TRIGGER brain_conflict_resolutions_immutable BEFORE UPDATE OR DELETE ON "brain_conflict_resolutions" FOR EACH ROW EXECUTE FUNCTION brain_immutable();
--> statement-breakpoint
CREATE TRIGGER brain_bundles_immutable BEFORE UPDATE OR DELETE ON "brain_bundles" FOR EACH ROW EXECUTE FUNCTION brain_immutable();
