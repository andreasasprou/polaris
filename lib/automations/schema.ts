import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { repositories } from "@/lib/integrations/schema";
import { secrets } from "@/lib/secrets/schema";
import { interactiveSessions } from "@/lib/sessions/schema";
import type { PRReviewConfig, AutomationSessionMetadata } from "@/lib/reviews/types";

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

  // Continuous mode fields
  mode: text("mode").default("oneshot").notNull(), // 'oneshot' | 'continuous'
  modelParams: jsonb("model_params").$type<Record<string, unknown>>().default({}).notNull(),
  prReviewConfig: jsonb("pr_review_config").$type<PRReviewConfig>().default({}).notNull(),

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

  // Continuous PR review fields (FKs added post-definition to avoid circular refs)
  automationSessionId: uuid("automation_session_id"),
  interactiveSessionId: uuid("interactive_session_id").references(
    () => interactiveSessions.id,
    { onDelete: "set null" },
  ),
  reviewSequence: integer("review_sequence"),
  reviewScope: text("review_scope"), // 'full' | 'incremental' | 'since' | 'reset'
  reviewFromSha: text("review_from_sha"),
  reviewToSha: text("review_to_sha"),
  githubCheckRunId: text("github_check_run_id"),
  githubCommentId: text("github_comment_id"),
  verdict: text("verdict"), // 'BLOCK' | 'ATTENTION' | 'APPROVE'
  severityCounts: jsonb("severity_counts").$type<{
    P0: number;
    P1: number;
    P2: number;
  }>(),
  supersededByRunId: uuid("superseded_by_run_id"),

  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Automation sessions — bridge between event-triggered automations
 * and long-lived interactive sessions.
 *
 * One PR = one automation_session row + one linked interactive_session.
 * Each push/manual trigger creates an automation_run pointing here.
 */
export const automationSessions = pgTable(
  "automation_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    interactiveSessionId: uuid("interactive_session_id")
      .notNull()
      .references(() => interactiveSessions.id, { onDelete: "restrict" }),
    organizationId: text("organization_id").notNull(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),

    scopeType: text("scope_type").default("github_pr").notNull(),
    scopeKey: text("scope_key").notNull(), // e.g. "github-pr:<repositoryId>:<prNumber>"

    status: text("status").default("active").notNull(), // 'active' | 'closing' | 'closed' | 'failed'

    metadata: jsonb("metadata")
      .$type<AutomationSessionMetadata>()
      .default({} as AutomationSessionMetadata)
      .notNull(),

    // Concurrency lock — only one review turn at a time
    reviewLockRunId: text("review_lock_run_id"),
    reviewLockExpiresAt: timestamp("review_lock_expires_at", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_automation_sessions_scope").on(
      table.automationId,
      table.scopeKey,
    ),
    index("idx_automation_sessions_interactive_session").on(
      table.interactiveSessionId,
    ),
    index("idx_automation_sessions_status").on(
      table.organizationId,
      table.status,
    ),
    index("idx_automation_sessions_lock").on(table.reviewLockExpiresAt),
  ],
);
