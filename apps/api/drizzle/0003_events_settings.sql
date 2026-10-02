ALTER TABLE "challenges" ADD COLUMN "show_events" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "share_events" boolean DEFAULT true NOT NULL;