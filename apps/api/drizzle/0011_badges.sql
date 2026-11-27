CREATE TABLE "activities" (
	"user_id" uuid NOT NULL,
	"id" text NOT NULL,
	"date" date NOT NULL,
	"sport" text NOT NULL,
	"name" text NOT NULL,
	"start_hour" integer,
	"minutes" double precision,
	"distance_km" double precision,
	"kcal" double precision,
	"source" text,
	"manual" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "badge_definitions" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"family" text NOT NULL,
	"icon" text NOT NULL,
	"image_url" text,
	"secret" boolean DEFAULT false NOT NULL,
	"rule" jsonb NOT NULL,
	"window_start" date,
	"window_end" date,
	"xp" jsonb,
	"counts_manual" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"origin" text DEFAULT 'admin' NOT NULL,
	"source_ref" text,
	"version" integer DEFAULT 1 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"customized" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "badge_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mime" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "badge_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_ref" text NOT NULL,
	"source_name" text NOT NULL,
	"source_description" text NOT NULL,
	"source_category" text,
	"source_start" date,
	"source_end" date,
	"status" text DEFAULT 'pending' NOT NULL,
	"draft" jsonb,
	"reason" text,
	"model" text,
	"badge_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "server_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_badges" (
	"user_id" uuid NOT NULL,
	"badge_key" text NOT NULL,
	"tier" integer NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"seen_at" timestamp with time zone,
	CONSTRAINT "user_badges_user_id_badge_key_tier_pk" PRIMARY KEY("user_id","badge_key","tier")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "badge_xp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "badge_showcase" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badge_key_badge_definitions_key_fk" FOREIGN KEY ("badge_key") REFERENCES "public"."badge_definitions"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_user_date_idx" ON "activities" USING btree ("user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "badge_suggestions_source_idx" ON "badge_suggestions" USING btree ("source_ref");--> statement-breakpoint
CREATE INDEX "user_badges_key_idx" ON "user_badges" USING btree ("badge_key");