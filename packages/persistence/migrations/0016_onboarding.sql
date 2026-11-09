CREATE TABLE "onboarding_readiness_passes" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"pass" integer NOT NULL,
	"blueprint_version" integer NOT NULL,
	"outcome" text NOT NULL,
	"checks" jsonb NOT NULL,
	"base_sha" text,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "onboarding_readiness_passes_tenant_id_project_id_pass_pk" PRIMARY KEY("tenant_id","project_id","pass"),
	CONSTRAINT "onboarding_readiness_outcome" CHECK ("onboarding_readiness_passes"."outcome" IN ('ready', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "onboarding_receipts" (
	"tenant_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"operation_key" text NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_receipts_tenant_id_scope_key_operation_key_pk" PRIMARY KEY("tenant_id","scope_key","operation_key")
);
--> statement-breakpoint
CREATE TABLE "project_blueprints" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"origin" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_blueprints_tenant_id_project_id_version_pk" PRIMARY KEY("tenant_id","project_id","version"),
	CONSTRAINT "project_blueprints_origin" CHECK ("project_blueprints"."origin" IN ('controller', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "project_onboardings" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"state" text NOT NULL,
	"condition_kind" text,
	"condition_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_blueprint_version" integer,
	"accepted_blueprint_version" integer,
	"cost_inputs" jsonb,
	"cost_confirmed_for_version" integer,
	"execution" jsonb,
	"connection" jsonb,
	"project_created" boolean DEFAULT false NOT NULL,
	"current_readiness_pass" integer,
	"first_run_id" text,
	"cancelled_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_onboardings_tenant_id_project_id_pk" PRIMARY KEY("tenant_id","project_id"),
	CONSTRAINT "project_onboardings_state" CHECK ("project_onboardings"."state" IN ('draft', 'discovering', 'blueprint_ready', 'configuring', 'readiness_check', 'ready', 'activated')),
	CONSTRAINT "project_onboardings_condition" CHECK ("project_onboardings"."condition_kind" IS NULL OR "project_onboardings"."condition_kind" IN ('needs_input', 'blocked', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "onboarding_readiness_passes" ADD CONSTRAINT "onboarding_readiness_passes_tenant_id_project_id_project_onboardings_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."project_onboardings"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_blueprints" ADD CONSTRAINT "project_blueprints_tenant_id_project_id_project_onboardings_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."project_onboardings"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_onboardings_live_name" ON "project_onboardings" USING btree ("tenant_id","name_key") WHERE cancelled_at IS NULL;--> statement-breakpoint
CREATE FUNCTION project_blueprints_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a blueprint version is immutable; write a new version instead';
END;
$$;--> statement-breakpoint
CREATE TRIGGER project_blueprints_no_update_or_delete BEFORE UPDATE OR DELETE ON "project_blueprints" FOR EACH ROW EXECUTE FUNCTION project_blueprints_immutable();
