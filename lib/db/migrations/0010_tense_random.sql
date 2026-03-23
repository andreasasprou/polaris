ALTER TABLE "interactive_session_runtimes" ADD COLUMN "proxy_cmd_id" text;--> statement-breakpoint
ALTER TABLE "interactive_session_runtimes" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "interactive_session_runtimes" ADD COLUMN "usage_summary" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "interactive_session_runtimes" ADD COLUMN "teardown_artifacts" jsonb DEFAULT '{}'::jsonb NOT NULL;