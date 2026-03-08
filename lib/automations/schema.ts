import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { repositories } from "@/lib/integrations/schema";
import { secrets } from "@/lib/secrets/schema";

export const automations = pgTable("automations", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  createdBy: text("created_by"),
  name: text("name").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  triggerType: text("trigger_type").notNull(), // 'github' | 'slack' | 'schedule' | 'webhook' | 'sentry'
  triggerConfig: jsonb("trigger_config").notNull().$type<Record<string, unknown>>(),
  prompt: text("prompt").notNull(),
  agentType: text("agent_type").notNull().default("claude"), // 'claude' | 'codex' | 'opencode' | 'amp'
  model: text("model"),
  agentMode: text("agent_mode"),
  repositoryId: uuid("repository_id").references(() => repositories.id),
  agentSecretId: uuid("agent_secret_id").references(() => secrets.id),
  webhookKeyHash: text("webhook_key_hash").unique(),
  triggerScheduleId: text("trigger_schedule_id"),
  approvalMode: text("approval_mode").default("none").notNull(),
  maxDurationSeconds: integer("max_duration_seconds").default(600).notNull(),
  maxConcurrentRuns: integer("max_concurrent_runs").default(1).notNull(),
  allowPush: boolean("allow_push").default(true).notNull(),
  allowPrCreate: boolean("allow_pr_create").default(true).notNull(),
  notifyOn: jsonb("notify_on").default(["failure"]).$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const automationRuns = pgTable("automation_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  automationId: uuid("automation_id")
    .notNull()
    .references(() => automations.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull(),
  triggerRunId: text("trigger_run_id"),
  status: text("status").default("pending").notNull(), // 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  source: text("source").notNull(), // 'github' | 'slack' | 'schedule' | 'webhook' | 'sentry'
  externalEventId: text("external_event_id"),
  dedupeKey: text("dedupe_key"),
  triggerEvent: jsonb("trigger_event").$type<Record<string, unknown>>(),
  agentSessionId: text("agent_session_id"), // Links to SDK persist session
  prUrl: text("pr_url"),
  branchName: text("branch_name"),
  summary: text("summary"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
