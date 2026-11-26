ALTER TABLE "challenges" ADD COLUMN "stake" text;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "stake_settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_review_month" text;