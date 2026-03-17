ALTER TABLE "automation_runs" DROP CONSTRAINT "automation_runs_interactive_session_id_interactive_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_sessions" DROP CONSTRAINT "automation_sessions_interactive_session_id_interactive_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "interactive_session_checkpoints" DROP CONSTRAINT "interactive_session_checkpoints_session_id_interactive_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "interactive_session_checkpoints" DROP CONSTRAINT "interactive_session_checkpoints_runtime_id_interactive_session_runtimes_id_fk";
--> statement-breakpoint
ALTER TABLE "interactive_session_runtimes" DROP CONSTRAINT "interactive_session_runtimes_session_id_interactive_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "interactive_session_turns" DROP CONSTRAINT "interactive_session_turns_runtime_id_interactive_session_runtimes_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_interactive_session_fk" FOREIGN KEY ("interactive_session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_sessions" ADD CONSTRAINT "automation_sessions_interactive_session_fk" FOREIGN KEY ("interactive_session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_checkpoints" ADD CONSTRAINT "interactive_session_checkpoints_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_checkpoints" ADD CONSTRAINT "interactive_session_checkpoints_runtime_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."interactive_session_runtimes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_runtimes" ADD CONSTRAINT "interactive_session_runtimes_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_session_turns" ADD CONSTRAINT "interactive_session_turns_runtime_fk" FOREIGN KEY ("runtime_id") REFERENCES "public"."interactive_session_runtimes"("id") ON DELETE set null ON UPDATE no action;