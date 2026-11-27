CREATE TABLE "health_origins" (
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"metric" text NOT NULL,
	"apps" jsonb NOT NULL,
	"counted" double precision,
	"capped" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_origins_user_id_date_metric_pk" PRIMARY KEY("user_id","date","metric")
);
--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD COLUMN "detail" jsonb;--> statement-breakpoint
ALTER TABLE "health_origins" ADD CONSTRAINT "health_origins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;