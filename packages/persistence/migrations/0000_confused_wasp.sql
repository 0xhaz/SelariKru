CREATE TABLE "project_sequences" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"last_sequence" bigint NOT NULL,
	CONSTRAINT "project_sequences_tenant_id_project_id_pk" PRIMARY KEY("tenant_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"repository" text NOT NULL,
	"default_branch" text NOT NULL,
	"classification" text NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"integration_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_tenant_id_project_id_pk" PRIMARY KEY("tenant_id","project_id"),
	CONSTRAINT "projects_project_id_key" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"request_revision" integer DEFAULT 1 NOT NULL,
	"plan_revision" integer,
	"lifecycle" text NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workflow_owner" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_tenant_id_project_id_run_id_pk" PRIMARY KEY("tenant_id","project_id","run_id")
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"attempt_number" integer NOT NULL,
	"runner" text,
	"harness" text,
	"lease_fence" integer,
	"model_route" text,
	"base_sha" text,
	"head_sha" text,
	"exit_reason" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "attempts_tenant_id_project_id_attempt_id_pk" PRIMARY KEY("tenant_id","project_id","attempt_id")
);
--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"reservation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text,
	"amount_usd" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "budget_reservations_tenant_id_project_id_reservation_id_pk" PRIMARY KEY("tenant_id","project_id","reservation_id")
);
--> statement-breakpoint
CREATE TABLE "dependencies" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"depends_on_task_id" text NOT NULL,
	"depends_on_revision" integer NOT NULL,
	"condition" text NOT NULL,
	CONSTRAINT "dependencies_tenant_id_project_id_task_id_revision_depends_on_task_id_depends_on_revision_pk" PRIMARY KEY("tenant_id","project_id","task_id","revision","depends_on_task_id","depends_on_revision")
);
--> statement-breakpoint
CREATE TABLE "resource_claims" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"resource_key" text NOT NULL,
	"mode" text NOT NULL,
	"attempt_id" text,
	"released_at" timestamp with time zone,
	CONSTRAINT "resource_claims_tenant_id_project_id_claim_id_pk" PRIMARY KEY("tenant_id","project_id","claim_id")
);
--> statement-breakpoint
CREATE TABLE "task_revisions" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"board_id" text NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_revisions_tenant_id_project_id_task_id_revision_pk" PRIMARY KEY("tenant_id","project_id","task_id","revision")
);
--> statement-breakpoint
CREATE TABLE "task_status" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"current_revision" integer NOT NULL,
	"status" text NOT NULL,
	"row_revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_status_tenant_id_project_id_task_id_pk" PRIMARY KEY("tenant_id","project_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"run_id" text,
	"task_id" text,
	"requester" text NOT NULL,
	"approver" text,
	"action_hash" text NOT NULL,
	"scope_hash" text NOT NULL,
	"expected_revisions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"policy" text,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_tenant_id_project_id_approval_id_pk" PRIMARY KEY("tenant_id","project_id","approval_id")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"run_id" text,
	"type" text NOT NULL,
	"sha256" text NOT NULL,
	"source_revision" text,
	"classification" text NOT NULL,
	"acl" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"locator" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_tenant_id_project_id_artifact_id_pk" PRIMARY KEY("tenant_id","project_id","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "check_runs" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"check_run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"attempt_id" text,
	"check_id" text NOT NULL,
	"check_version" text NOT NULL,
	"candidate_sha" text NOT NULL,
	"result" text NOT NULL,
	"log_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_runs_tenant_id_project_id_check_run_id_pk" PRIMARY KEY("tenant_id","project_id","check_run_id")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"context" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text NOT NULL,
	"author" text NOT NULL,
	"affected" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"superseded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_tenant_id_project_id_decision_id_pk" PRIMARY KEY("tenant_id","project_id","decision_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_edges" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"edge_id" text NOT NULL,
	"from_node_id" text NOT NULL,
	"to_node_id" text NOT NULL,
	"relation" text NOT NULL,
	"status" text NOT NULL,
	"acl" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"freshness" text NOT NULL,
	CONSTRAINT "knowledge_edges_tenant_id_project_id_edge_id_pk" PRIMARY KEY("tenant_id","project_id","edge_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_nodes" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"node_id" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"version" text NOT NULL,
	"acl" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"freshness" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "knowledge_nodes_tenant_id_project_id_node_id_pk" PRIMARY KEY("tenant_id","project_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "consumer_cursors" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"consumer" text NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumer_cursors_tenant_id_project_id_consumer_pk" PRIMARY KEY("tenant_id","project_id","consumer")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"schema_version" integer NOT NULL,
	"event_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"attempt_id" text,
	"type" text NOT NULL,
	"aggregate_revision" integer NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"causation_id" text,
	"trace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "events_tenant_id_project_id_sequence_pk" PRIMARY KEY("tenant_id","project_id","sequence"),
	CONSTRAINT "events_event_id_key" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "integration_deliveries" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"integration" text NOT NULL,
	"sequence" bigint NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_deliveries_tenant_id_project_id_delivery_id_pk" PRIMARY KEY("tenant_id","project_id","delivery_id"),
	CONSTRAINT "integration_deliveries_dedupe" UNIQUE("tenant_id","project_id","integration","sequence")
);
--> statement-breakpoint
CREATE TABLE "operation_receipts" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operation_receipts_tenant_id_project_id_operation_key_pk" PRIMARY KEY("tenant_id","project_id","operation_key")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"claim_expires_at" timestamp with time zone,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "outbox_tenant_id_project_id_sequence_pk" PRIMARY KEY("tenant_id","project_id","sequence")
);
--> statement-breakpoint
ALTER TABLE "project_sequences" ADD CONSTRAINT "project_sequences_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_tenant_id_project_id_task_id_revision_task_revisions_tenant_id_project_id_task_id_revision_fk" FOREIGN KEY ("tenant_id","project_id","task_id","revision") REFERENCES "public"."task_revisions"("tenant_id","project_id","task_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_tenant_id_project_id_run_id_runs_tenant_id_project_id_run_id_fk" FOREIGN KEY ("tenant_id","project_id","run_id") REFERENCES "public"."runs"("tenant_id","project_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_tenant_id_project_id_task_id_revision_task_revisions_tenant_id_project_id_task_id_revision_fk" FOREIGN KEY ("tenant_id","project_id","task_id","revision") REFERENCES "public"."task_revisions"("tenant_id","project_id","task_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_tenant_id_project_id_depends_on_task_id_depends_on_revision_task_revisions_tenant_id_project_id_task_id_revision_fk" FOREIGN KEY ("tenant_id","project_id","depends_on_task_id","depends_on_revision") REFERENCES "public"."task_revisions"("tenant_id","project_id","task_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_claims" ADD CONSTRAINT "resource_claims_tenant_id_project_id_task_id_revision_task_revisions_tenant_id_project_id_task_id_revision_fk" FOREIGN KEY ("tenant_id","project_id","task_id","revision") REFERENCES "public"."task_revisions"("tenant_id","project_id","task_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_claims" ADD CONSTRAINT "resource_claims_tenant_id_project_id_attempt_id_attempts_tenant_id_project_id_attempt_id_fk" FOREIGN KEY ("tenant_id","project_id","attempt_id") REFERENCES "public"."attempts"("tenant_id","project_id","attempt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_revisions" ADD CONSTRAINT "task_revisions_tenant_id_project_id_run_id_runs_tenant_id_project_id_run_id_fk" FOREIGN KEY ("tenant_id","project_id","run_id") REFERENCES "public"."runs"("tenant_id","project_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_status" ADD CONSTRAINT "task_status_tenant_id_project_id_task_id_current_revision_task_revisions_tenant_id_project_id_task_id_revision_fk" FOREIGN KEY ("tenant_id","project_id","task_id","current_revision") REFERENCES "public"."task_revisions"("tenant_id","project_id","task_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_project_id_run_id_runs_tenant_id_project_id_run_id_fk" FOREIGN KEY ("tenant_id","project_id","run_id") REFERENCES "public"."runs"("tenant_id","project_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_tenant_id_project_id_run_id_runs_tenant_id_project_id_run_id_fk" FOREIGN KEY ("tenant_id","project_id","run_id") REFERENCES "public"."runs"("tenant_id","project_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_tenant_id_project_id_task_id_revision_task_revisions_tenant_id_project_id_task_id_revision_fk" FOREIGN KEY ("tenant_id","project_id","task_id","revision") REFERENCES "public"."task_revisions"("tenant_id","project_id","task_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_tenant_id_project_id_attempt_id_attempts_tenant_id_project_id_attempt_id_fk" FOREIGN KEY ("tenant_id","project_id","attempt_id") REFERENCES "public"."attempts"("tenant_id","project_id","attempt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_tenant_id_project_id_superseded_by_decisions_tenant_id_project_id_decision_id_fk" FOREIGN KEY ("tenant_id","project_id","superseded_by") REFERENCES "public"."decisions"("tenant_id","project_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_tenant_id_project_id_from_node_id_knowledge_nodes_tenant_id_project_id_node_id_fk" FOREIGN KEY ("tenant_id","project_id","from_node_id") REFERENCES "public"."knowledge_nodes"("tenant_id","project_id","node_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_tenant_id_project_id_to_node_id_knowledge_nodes_tenant_id_project_id_node_id_fk" FOREIGN KEY ("tenant_id","project_id","to_node_id") REFERENCES "public"."knowledge_nodes"("tenant_id","project_id","node_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_nodes" ADD CONSTRAINT "knowledge_nodes_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumer_cursors" ADD CONSTRAINT "consumer_cursors_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_project_id_run_id_runs_tenant_id_project_id_run_id_fk" FOREIGN KEY ("tenant_id","project_id","run_id") REFERENCES "public"."runs"("tenant_id","project_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_deliveries" ADD CONSTRAINT "integration_deliveries_tenant_id_project_id_sequence_events_tenant_id_project_id_sequence_fk" FOREIGN KEY ("tenant_id","project_id","sequence") REFERENCES "public"."events"("tenant_id","project_id","sequence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_receipts" ADD CONSTRAINT "operation_receipts_tenant_id_project_id_projects_tenant_id_project_id_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_project_id_sequence_events_tenant_id_project_id_sequence_fk" FOREIGN KEY ("tenant_id","project_id","sequence") REFERENCES "public"."events"("tenant_id","project_id","sequence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_undelivered_idx" ON "outbox" USING btree ("project_id","sequence") WHERE delivered_at IS NULL;