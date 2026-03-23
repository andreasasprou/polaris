ALTER TABLE "interactive_sessions" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "interactive_sessions" ADD COLUMN "model_params" jsonb DEFAULT '{}'::jsonb NOT NULL;