CREATE TABLE "control_inputs" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"char_count" integer NOT NULL,
	"disposition" text NOT NULL,
	"text" text,
	CONSTRAINT "control_inputs_tenant_id_project_id_session_id_seq_pk" PRIMARY KEY("tenant_id","project_id","session_id","seq"),
	CONSTRAINT "control_inputs_disposition" CHECK (disposition IN ('pending', 'recorded', 'withheld_echo_off', 'withheld_unconfirmed', 'interrupt')),
	CONSTRAINT "control_inputs_text_only_recorded" CHECK (text IS NULL OR disposition = 'recorded')
);
--> statement-breakpoint
CREATE TABLE "control_sessions" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"runner" text NOT NULL,
	"lease_fence" integer NOT NULL,
	"owner_uid" text NOT NULL,
	"origin" text NOT NULL,
	"ticket_hash" text NOT NULL,
	"ticket_expires_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"entered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"input_count" bigint DEFAULT 0 NOT NULL,
	"withheld_count" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "control_sessions_tenant_id_project_id_session_id_pk" PRIMARY KEY("tenant_id","project_id","session_id"),
	CONSTRAINT "control_sessions_state" CHECK (state IN ('minted', 'active', 'ended', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "human_intervened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "control_inputs" ADD CONSTRAINT "control_inputs_tenant_id_project_id_session_id_control_sessions_tenant_id_project_id_session_id_fk" FOREIGN KEY ("tenant_id","project_id","session_id") REFERENCES "public"."control_sessions"("tenant_id","project_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_sessions" ADD CONSTRAINT "control_sessions_tenant_id_project_id_attempt_id_attempts_tenant_id_project_id_attempt_id_fk" FOREIGN KEY ("tenant_id","project_id","attempt_id") REFERENCES "public"."attempts"("tenant_id","project_id","attempt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "control_sessions_one_open" ON "control_sessions" USING btree ("tenant_id","project_id","attempt_id") WHERE state IN ('minted', 'active');--> statement-breakpoint
CREATE UNIQUE INDEX "control_sessions_ticket_key" ON "control_sessions" USING btree ("ticket_hash");