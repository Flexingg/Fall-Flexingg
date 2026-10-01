ALTER TABLE "challenge_participants" ADD COLUMN "params" jsonb;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "max_participants" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "handle" text;--> statement-breakpoint
CREATE INDEX "challenges_visibility_idx" ON "challenges" USING btree ("visibility","end_date");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_handle_unique" UNIQUE("handle");