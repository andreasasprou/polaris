CREATE TABLE "key_pool_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_selected_at" timestamp with time zone,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "key_pool_members_pool_id_secret_id_unique" UNIQUE("pool_id","secret_id")
);
--> statement-breakpoint
CREATE TABLE "key_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "key_pools_organization_id_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "key_pool_id" uuid;--> statement-breakpoint
ALTER TABLE "interactive_session_runtimes" ADD COLUMN "agent_server_url" text;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD COLUMN "key_pool_id" uuid;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "resolved_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "key_pool_members" ADD CONSTRAINT "key_pool_members_pool_id_key_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."key_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_pool_members" ADD CONSTRAINT "key_pool_members_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_key_pool_members_pool" ON "key_pool_members" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "idx_key_pool_members_selection" ON "key_pool_members" USING btree ("pool_id","enabled","last_selected_at");--> statement-breakpoint
CREATE INDEX "idx_key_pools_org" ON "key_pools" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_key_pool_id_key_pools_id_fk" FOREIGN KEY ("key_pool_id") REFERENCES "public"."key_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD CONSTRAINT "interactive_sessions_key_pool_id_key_pools_id_fk" FOREIGN KEY ("key_pool_id") REFERENCES "public"."key_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_automations_key_pool" ON "automations" USING btree ("key_pool_id");--> statement-breakpoint
CREATE INDEX "idx_interactive_sessions_key_pool" ON "interactive_sessions" USING btree ("key_pool_id");--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "chk_automations_key_source" CHECK ("automations"."agent_secret_id" IS NULL OR "automations"."key_pool_id" IS NULL);--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD CONSTRAINT "chk_sessions_key_source" CHECK ("interactive_sessions"."agent_secret_id" IS NULL OR "interactive_sessions"."key_pool_id" IS NULL);