ALTER TABLE "accepted_proposals" DROP CONSTRAINT "accepted_proposals_state";--> statement-breakpoint
ALTER TABLE "accepted_proposals" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "accepted_proposals" ADD COLUMN "accept_key" text;--> statement-breakpoint
ALTER TABLE "accepted_proposals" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "accepted_proposals" ADD CONSTRAINT "accepted_proposals_state" CHECK ("accepted_proposals"."state" IN ('accepted', 'applying', 'applied', 'failed', 'superseded'));