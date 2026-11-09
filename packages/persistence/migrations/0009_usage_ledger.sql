CREATE TABLE "usage_entries" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text,
	"revision" integer,
	"attempt_id" text,
	"role" text NOT NULL,
	"metric" text NOT NULL,
	"quantity" numeric(24, 6),
	"provenance" text NOT NULL,
	"source" text NOT NULL,
	"phase" text,
	"host" text,
	"basis" text,
	"rate_card_version" text,
	"corrects_entry_id" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "usage_entries_tenant_id_project_id_entry_id_pk" PRIMARY KEY("tenant_id","project_id","entry_id"),
	CONSTRAINT "usage_entries_task_revision_paired" CHECK ((task_id IS NULL) = (revision IS NULL)),
	CONSTRAINT "usage_entries_provenance" CHECK (provenance IN ('observed', 'estimated', 'unavailable')),
	CONSTRAINT "usage_entries_unknown_is_null" CHECK ((quantity IS NULL) = (provenance = 'unavailable')),
	CONSTRAINT "usage_entries_quantity_nonnegative" CHECK (quantity IS NULL OR quantity >= 0),
	CONSTRAINT "usage_entries_self_report_not_observed" CHECK (NOT (provenance = 'observed' AND source IN ('worker_report', 'harness_report'))),
	CONSTRAINT "usage_entries_worker_time_dimensions" CHECK ((metric = 'worker_seconds') = (phase IS NOT NULL AND host IS NOT NULL AND basis IS NOT NULL))
);
--> statement-breakpoint
-- A stored amount that is not a plain non-negative decimal becomes null: the budget read then reports it as unknown and denies, as it did before.
ALTER TABLE "budget_reservations" ALTER COLUMN "amount_usd" SET DATA TYPE numeric(18, 6) USING (CASE WHEN "amount_usd" ~ '^[0-9]{1,12}(\.[0-9]+)?$' THEN "amount_usd"::numeric(18, 6) END);--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD COLUMN "amount_provenance" text DEFAULT 'unavailable' NOT NULL;--> statement-breakpoint
-- Every amount written so far is a worst-case hold from the task's limits.
UPDATE "budget_reservations" SET "amount_provenance" = 'estimated' WHERE "amount_usd" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD CONSTRAINT "usage_entries_tenant_id_project_id_run_id_runs_tenant_id_project_id_run_id_fk" FOREIGN KEY ("tenant_id","project_id","run_id") REFERENCES "public"."runs"("tenant_id","project_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD CONSTRAINT "usage_entries_tenant_id_project_id_task_id_revision_task_revisions_tenant_id_project_id_task_id_revision_fk" FOREIGN KEY ("tenant_id","project_id","task_id","revision") REFERENCES "public"."task_revisions"("tenant_id","project_id","task_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD CONSTRAINT "usage_entries_tenant_id_project_id_attempt_id_attempts_tenant_id_project_id_attempt_id_fk" FOREIGN KEY ("tenant_id","project_id","attempt_id") REFERENCES "public"."attempts"("tenant_id","project_id","attempt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD CONSTRAINT "usage_entries_corrects_fk" FOREIGN KEY ("tenant_id","project_id","corrects_entry_id") REFERENCES "public"."usage_entries"("tenant_id","project_id","entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_entries_dedupe_key" ON "usage_entries" USING btree ("tenant_id","project_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_entries_one_correction" ON "usage_entries" USING btree ("tenant_id","project_id","corrects_entry_id") WHERE corrects_entry_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "usage_entries_run" ON "usage_entries" USING btree ("tenant_id","project_id","run_id");--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_amount_provenance" CHECK (amount_provenance IN ('observed', 'estimated', 'unavailable'));--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_unknown_is_null" CHECK ((amount_usd IS NULL) = (amount_provenance = 'unavailable'));--> statement-breakpoint
CREATE FUNCTION usage_entries_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'usage_entries is append-only; write a correcting row instead';
END;
$$;--> statement-breakpoint
CREATE TRIGGER usage_entries_no_update_or_delete BEFORE UPDATE OR DELETE ON "usage_entries" FOR EACH ROW EXECUTE FUNCTION usage_entries_append_only();
