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
ALTER TABLE "interactive_sessions" ADD COLUMN "native_agent_session_id" text;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD COLUMN "cwd" text;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD COLUMN "latest_checkpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "interactive_session_checkpoints" ADD CONSTRAINT "interactive_session_checkpoints_session_id_interactive_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_checkpoints" ADD CONSTRAINT "interactive_session_checkpoints_runtime_id_interactive_session_runtimes_id_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."interactive_session_runtimes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_runtimes" ADD CONSTRAINT "interactive_session_runtimes_session_id_interactive_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_one_live_runtime_per_session" ON "interactive_session_runtimes" USING btree ("session_id") WHERE status IN ('creating', 'running', 'warm');