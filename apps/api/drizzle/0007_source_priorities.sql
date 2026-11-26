ALTER TABLE "users" ADD COLUMN "source_priorities" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "seen_sources" jsonb DEFAULT '{}'::jsonb NOT NULL;