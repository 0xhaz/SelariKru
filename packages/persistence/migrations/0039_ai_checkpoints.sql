CREATE TABLE "ai_checkpoints" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"owner_uid" text NOT NULL,
	"task_id" text NOT NULL,
	"status" text NOT NULL,
	"stop_reason" text,
	"escalated_at" timestamp with time zone,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_checkpoints_tenant_id_project_id_checkpoint_id_pk" PRIMARY KEY("tenant_id","project_id","checkpoint_id"),
	CONSTRAINT "ai_checkpoints_status" CHECK ("ai_checkpoints"."status" IN ('running', 'waiting', 'done', 'sent', 'escalated', 'moved_to_device', 'dropped')),
	CONSTRAINT "ai_checkpoints_not_locked" CHECK (("ai_checkpoints"."body" ->> 'locked') = 'false'),
	CONSTRAINT "ai_checkpoints_no_restricted_labels" CHECK (NOT ("ai_checkpoints"."body" -> 'labels' ?| array['restricted', 'secret'])),
	CONSTRAINT "ai_checkpoints_no_restricted_texts" CHECK (NOT jsonb_path_exists("ai_checkpoints"."body", '$.partial.texts[*] ? (@.classification == "restricted" || @.classification == "secret")'))
);
--> statement-breakpoint
ALTER TABLE "ai_checkpoints" ADD CONSTRAINT "ai_checkpoints_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_checkpoints_owner_idx" ON "ai_checkpoints" USING btree ("tenant_id","project_id","owner_uid","updated_at");