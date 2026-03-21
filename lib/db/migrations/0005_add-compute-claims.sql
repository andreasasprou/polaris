-- Compute Claims table: tracks who needs a running sandbox and why.
-- The runtime controller reads active claims to decide sandbox lifecycle.
-- Consumers create/release claims. Only the controller touches Vercel.

CREATE TABLE IF NOT EXISTS "compute_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "claimant" text NOT NULL,
  "reason" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "released_at" timestamp with time zone
);
--> statement-breakpoint

-- Fast lookup: active claims for a session
CREATE INDEX "idx_compute_claims_session_active"
  ON "compute_claims" ("session_id")
  WHERE released_at IS NULL;
--> statement-breakpoint

-- Sweeper: find expired claims
CREATE INDEX "idx_compute_claims_expired"
  ON "compute_claims" ("expires_at")
  WHERE released_at IS NULL;
--> statement-breakpoint

-- Foreign key to interactive_sessions
ALTER TABLE "compute_claims"
  ADD CONSTRAINT "compute_claims_session_fk"
  FOREIGN KEY ("session_id") REFERENCES "interactive_sessions"("id");
