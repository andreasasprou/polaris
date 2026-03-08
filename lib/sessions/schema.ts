import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { repositories } from "@/lib/integrations/schema";
import { secrets } from "@/lib/secrets/schema";

/**
 * Interactive agent sessions — manual, multi-turn sessions started by users.
 * Separate from automation_runs (which are triggered by automations).
 */
export const interactiveSessions = pgTable("interactive_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  createdBy: text("created_by").notNull(),

  // Agent config
  agentType: text("agent_type").notNull().default("claude"),
  agentSecretId: uuid("agent_secret_id").references(() => secrets.id),
  repositoryId: uuid("repository_id").references(() => repositories.id),
  prompt: text("prompt").notNull(),

  // Runtime state
  status: text("status").default("creating").notNull(), // creating | active | completed | failed | stopped
  sdkSessionId: text("sdk_session_id"), // sandbox-agent SDK session ID (links to sandbox_agent.sessions)
  sandboxId: text("sandbox_id"),
  sandboxBaseUrl: text("sandbox_base_url"), // For forwarding prompts/approvals
  triggerRunId: text("trigger_run_id"), // Trigger.dev run ID

  // Results
  summary: text("summary"),
  error: text("error"),

  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
