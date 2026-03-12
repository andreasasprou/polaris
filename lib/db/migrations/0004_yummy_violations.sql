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
ALTER TABLE "automation_runs" ADD COLUMN "automation_session_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "interactive_session_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "review_sequence" integer;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "review_scope" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "review_from_sha" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "review_to_sha" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "github_check_run_id" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "github_comment_id" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "severity_counts" jsonb;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "superseded_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "mode" text DEFAULT 'oneshot' NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "model_params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "pr_review_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_sessions" ADD CONSTRAINT "automation_sessions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_sessions" ADD CONSTRAINT "automation_sessions_interactive_session_id_interactive_sessions_id_fk" FOREIGN KEY ("interactive_session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_sessions" ADD CONSTRAINT "automation_sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_turns" ADD CONSTRAINT "interactive_session_turns_session_id_interactive_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_turns" ADD CONSTRAINT "interactive_session_turns_runtime_id_interactive_session_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."interactive_session_runtimes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_sessions_scope" ON "automation_sessions" USING btree ("automation_id","scope_key");--> statement-breakpoint
CREATE INDEX "idx_automation_sessions_interactive_session" ON "automation_sessions" USING btree ("interactive_session_id");--> statement-breakpoint
CREATE INDEX "idx_automation_sessions_status" ON "automation_sessions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_automation_sessions_lock" ON "automation_sessions" USING btree ("review_lock_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_interactive_session_turn_request" ON "interactive_session_turns" USING btree ("session_id","request_id");--> statement-breakpoint
CREATE INDEX "idx_interactive_session_turn_status" ON "interactive_session_turns" USING btree ("session_id","status");--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_interactive_session_id_interactive_sessions_id_fk" FOREIGN KEY ("interactive_session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE set null ON UPDATE no action;