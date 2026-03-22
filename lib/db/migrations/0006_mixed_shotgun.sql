CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"server_url" text NOT NULL,
	"transport" text DEFAULT 'streamable-http' NOT NULL,
	"auth_type" text NOT NULL,
	"encrypted_auth_config" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"oauth_client_id" text,
	"oauth_authorization_endpoint" text,
	"oauth_token_endpoint" text,
	"oauth_scopes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_organization_id_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "interactive_session_runtimes" ADD COLUMN "agent_server_url" text;