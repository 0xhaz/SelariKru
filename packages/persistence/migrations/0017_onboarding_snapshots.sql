ALTER TABLE "runs" ADD COLUMN "setup_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "configured_projects" jsonb;--> statement-breakpoint
ALTER TABLE "onboarding_readiness_passes" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
CREATE FUNCTION readiness_passes_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a readiness pass is immutable; write a new pass instead';
END;
$$;--> statement-breakpoint
CREATE TRIGGER onboarding_readiness_passes_no_update_or_delete BEFORE UPDATE OR DELETE ON "onboarding_readiness_passes" FOR EACH ROW EXECUTE FUNCTION readiness_passes_immutable();
