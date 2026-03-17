CREATE TABLE "callback_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"callback_id" text NOT NULL,
	"callback_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"process_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"epoch" integer NOT NULL,
	"sandbox_id" text,
	"status" text DEFAULT 'dispatching' NOT NULL,
	"result_payload" jsonb,
	"error" text,
	"last_progress_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"session_id" uuid,
	"automation_id" uuid,
	"automation_run_id" uuid,
	"request_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"timeout_seconds" integer DEFAULT 1200 NOT NULL,
	"hmac_key" text,
	"result" jsonb,
	"side_effects_completed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"timeout_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_automation_sessions_lock";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_one_live_runtime_per_session";--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "job_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_sessions" ADD COLUMN IF NOT EXISTS "review_lock_job_id" uuid;--> statement-breakpoint
ALTER TABLE "interactive_session_runtimes" ADD COLUMN IF NOT EXISTS "epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "interactive_session_turns" ADD COLUMN IF NOT EXISTS "job_id" uuid;--> statement-breakpoint
ALTER TABLE "interactive_session_turns" ADD COLUMN IF NOT EXISTS "attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD COLUMN IF NOT EXISTS "epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "callback_inbox" ADD CONSTRAINT "callback_inbox_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_inbox" ADD CONSTRAINT "callback_inbox_attempt_id_job_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."job_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_attempt_id_job_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."job_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_session_id_interactive_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interactive_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_automation_run_id_automation_runs_id_fk" FOREIGN KEY ("automation_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_callback_inbox_dedupe" ON "callback_inbox" USING btree ("job_id","attempt_id","epoch","callback_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_job_attempt_unique" ON "job_attempts" USING btree ("job_id","attempt_number");--> statement-breakpoint
CREATE INDEX "idx_job_attempts_job" ON "job_attempts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_job_attempts_epoch" ON "job_attempts" USING btree ("epoch");--> statement-breakpoint
CREATE INDEX "idx_job_events_job" ON "job_events" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_jobs_request_id" ON "jobs" USING btree ("session_id","request_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_status" ON "jobs" USING btree ("status") WHERE status NOT IN ('completed', 'failed_terminal', 'cancelled');--> statement-breakpoint
CREATE INDEX "idx_jobs_timeout" ON "jobs" USING btree ("timeout_at") WHERE status IN ('accepted', 'running');--> statement-breakpoint
CREATE INDEX "idx_jobs_session" ON "jobs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_automation" ON "jobs" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "idx_automation_sessions_lock" ON "automation_sessions" USING btree ("review_lock_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_one_live_runtime_per_session" ON "interactive_session_runtimes" USING btree ("session_id") WHERE status IN ('creating', 'running', 'idle');--> statement-breakpoint
ALTER TABLE "automation_runs" DROP COLUMN IF EXISTS "trigger_run_id";--> statement-breakpoint
ALTER TABLE "automation_sessions" DROP COLUMN IF EXISTS "review_lock_run_id";--> statement-breakpoint
ALTER TABLE "automation_sessions" DROP COLUMN IF EXISTS "review_lock_expires_at";--> statement-breakpoint
ALTER TABLE "interactive_session_runtimes" DROP COLUMN IF EXISTS "trigger_run_id";--> statement-breakpoint
ALTER TABLE "interactive_sessions" DROP COLUMN IF EXISTS "trigger_run_id";--> statement-breakpoint
ALTER TABLE "interactive_session_runtimes" ALTER COLUMN "epoch" DROP DEFAULT;--> statement-breakpoint
DO $$
DECLARE
  conflicting_installation integer;
BEGIN
  SELECT gi.installation_id
  INTO conflicting_installation
  FROM github_installations gi
  JOIN repositories r ON r.github_installation_id = gi.id
  GROUP BY gi.installation_id
  HAVING count(DISTINCT gi.organization_id) > 1
  LIMIT 1;

  IF conflicting_installation IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot automatically deduplicate github_installations for installation_id % because repositories exist in multiple organizations.',
      conflicting_installation;
  END IF;
END $$;--> statement-breakpoint
WITH ranked_installations AS (
  SELECT
    gi.id,
    gi.installation_id,
    row_number() OVER (
      PARTITION BY gi.installation_id
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM repositories r
            WHERE r.github_installation_id = gi.id
          ) THEN 0
          ELSE 1
        END,
        gi.created_at,
        gi.id
    ) AS rank
  FROM github_installations gi
),
canonical_installations AS (
  SELECT installation_id, id AS canonical_id
  FROM ranked_installations
  WHERE rank = 1
),
duplicate_installations AS (
  SELECT
    ranked_installations.id AS duplicate_id,
    canonical_installations.canonical_id
  FROM ranked_installations
  JOIN canonical_installations USING (installation_id)
  WHERE ranked_installations.id <> canonical_installations.canonical_id
)
UPDATE repositories
SET github_installation_id = duplicate_installations.canonical_id
FROM duplicate_installations
WHERE repositories.github_installation_id = duplicate_installations.duplicate_id;--> statement-breakpoint
WITH ranked_installations AS (
  SELECT
    gi.id,
    gi.installation_id,
    row_number() OVER (
      PARTITION BY gi.installation_id
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM repositories r
            WHERE r.github_installation_id = gi.id
          ) THEN 0
          ELSE 1
        END,
        gi.created_at,
        gi.id
    ) AS rank
  FROM github_installations gi
)
DELETE FROM github_installations
USING ranked_installations
WHERE github_installations.id = ranked_installations.id
  AND ranked_installations.rank > 1;--> statement-breakpoint
ALTER TABLE "github_installations" DROP CONSTRAINT "github_installations_organization_id_installation_id_unique";--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id");
