ALTER TABLE "mcp_servers" ADD COLUMN "catalog_slug" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_test_status" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_test_error" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_tested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_discovered_tools" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_mcp_servers_catalog_slug" ON "mcp_servers" USING btree ("organization_id","catalog_slug") WHERE "mcp_servers"."catalog_slug" IS NOT NULL;