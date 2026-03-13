CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"installation_id" integer NOT NULL,
	"account_login" text,
	"account_type" text,
	"installed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_organization_id_installation_id_unique" UNIQUE("organization_id","installation_id")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"github_installation_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_organization_id_owner_name_unique" UNIQUE("organization_id","owner","name")
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"created_by" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_organization_id_provider_label_unique" UNIQUE("organization_id","provider","label")
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"trigger_run_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text NOT NULL,
	"external_event_id" text,
	"dedupe_key" text,
	"trigger_event" jsonb,
	"agent_session_id" text,
	"pr_url" text,
	"branch_name" text,
	"summary" text,
	"error" text,
	"automation_session_id" uuid,
	"interactive_session_id" uuid,
	"review_sequence" integer,
	"review_scope" text,
	"review_from_sha" text,
	"review_to_sha" text,
	"github_check_run_id" text,
	"github_comment_id" text,
	"verdict" text,
	"severity_counts" jsonb,
	"metrics" jsonb,
	"superseded_by_run_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"interactive_session_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"repository_id" uuid NOT NULL,
	"scope_type" text DEFAULT 'github_pr' NOT NULL,
	"scope_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"review_lock_run_id" text,
	"review_lock_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"created_by" text,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb NOT NULL,
	"prompt" text NOT NULL,
	"agent_type" text DEFAULT 'claude' NOT NULL,
	"model" text,
	"agent_mode" text,
	"repository_id" uuid,
	"agent_secret_id" uuid,
	"webhook_key_hash" text,
	"trigger_schedule_id" text,
	"approval_mode" text DEFAULT 'none' NOT NULL,
	"max_duration_seconds" integer DEFAULT 600 NOT NULL,
	"max_concurrent_runs" integer DEFAULT 1 NOT NULL,
	"allow_push" boolean DEFAULT true NOT NULL,
	"allow_pr_create" boolean DEFAULT true NOT NULL,
	"notify_on" jsonb DEFAULT '["failure"]'::jsonb NOT NULL,
	"mode" text DEFAULT 'oneshot' NOT NULL,
	"model_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pr_review_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_webhook_key_hash_unique" UNIQUE("webhook_key_hash")
);
--> statement-breakpoint
CREATE TABLE "interactive_session_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"runtime_id" uuid,
	"snapshot_id" text NOT NULL,
	"base_commit_sha" text,
	"last_event_index" integer,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interactive_session_runtimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"sandbox_id" text,
	"sandbox_base_url" text,
	"trigger_run_id" text,
	"sdk_session_id" text,
	"restore_source" text NOT NULL,
	"restore_snapshot_id" text,
	"status" text DEFAULT 'creating' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interactive_session_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"runtime_id" uuid,
	"request_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"prompt" text NOT NULL,
	"final_message" text,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactive_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"agent_type" text DEFAULT 'claude' NOT NULL,
	"agent_secret_id" uuid,
	"repository_id" uuid,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"sdk_session_id" text,
	"sandbox_id" text,
	"sandbox_base_url" text,
	"trigger_run_id" text,
	"native_agent_session_id" text,
	"cwd" text,
	"latest_checkpoint_id" uuid,
	"summary" text,
	"error" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_event_id" text,
	"source_delivery_id" text,
	"dedupe_key" text NOT NULL,
	"organization_id" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_deliveries_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "sandbox_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" text NOT NULL,
	"agent_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"sandbox_agent_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sandbox_env_vars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_env_vars_organization_id_key_unique" UNIQUE("organization_id","key")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_github_installation_id_github_installations_id_fk" FOREIGN KEY ("github_installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_session_id_automation_sessions_id_fk" FOREIGN KEY ("automation_session_id") REFERENCES "public"."automation_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_interactive_session_id_interactive_sessions_id_fk" FOREIGN KEY ("interactive_session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_sessions" ADD CONSTRAINT "automation_sessions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_sessions" ADD CONSTRAINT "automation_sessions_interactive_session_id_interactive_sessions_id_fk" FOREIGN KEY ("interactive_session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_sessions" ADD CONSTRAINT "automation_sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_agent_secret_id_secrets_id_fk" FOREIGN KEY ("agent_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_checkpoints" ADD CONSTRAINT "interactive_session_checkpoints_session_id_interactive_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_checkpoints" ADD CONSTRAINT "interactive_session_checkpoints_runtime_id_interactive_session_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."interactive_session_runtimes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_runtimes" ADD CONSTRAINT "interactive_session_runtimes_session_id_interactive_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_turns" ADD CONSTRAINT "interactive_session_turns_session_id_interactive_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_turns" ADD CONSTRAINT "interactive_session_turns_runtime_id_interactive_session_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."interactive_session_runtimes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD CONSTRAINT "interactive_sessions_agent_secret_id_secrets_id_fk" FOREIGN KEY ("agent_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD CONSTRAINT "interactive_sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_org" ON "automation_runs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_automation_created" ON "automation_runs" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_sessions_scope" ON "automation_sessions" USING btree ("automation_id","scope_key");--> statement-breakpoint
CREATE INDEX "idx_automation_sessions_interactive_session" ON "automation_sessions" USING btree ("interactive_session_id");--> statement-breakpoint
CREATE INDEX "idx_automation_sessions_status" ON "automation_sessions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_automation_sessions_lock" ON "automation_sessions" USING btree ("review_lock_expires_at");--> statement-breakpoint
CREATE INDEX "idx_automations_org" ON "automations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_one_live_runtime_per_session" ON "interactive_session_runtimes" USING btree ("session_id") WHERE status IN ('creating', 'running', 'warm', 'suspended');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_interactive_session_turn_request" ON "interactive_session_turns" USING btree ("session_id","request_id");--> statement-breakpoint
CREATE INDEX "idx_interactive_session_turn_status" ON "interactive_session_turns" USING btree ("session_id","status");