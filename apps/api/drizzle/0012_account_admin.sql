ALTER TABLE "users" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
UPDATE "users" u SET "last_active_at" = GREATEST(u."created_at", u."last_synced_at", (SELECT max(coalesce(t."rotated_at", t."created_at")) FROM "refresh_tokens" t WHERE t."user_id" = u."id"));
