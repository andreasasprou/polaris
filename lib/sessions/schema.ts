import { pgTable, uuid, text, timestamp, integer, bigint, uniqueIndex, index, jsonb, foreignKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { repositories } from "@/lib/integrations/schema";
import { secrets } from "@/lib/secrets/schema";
import { keyPools } from "@/lib/key-pools/schema";
import type { ModelParams } from "@/lib/sandbox-agent/types";

/**
 * Interactive agent sessions — manual, multi-turn sessions started by users.
 * Separate from automation_runs (which are triggered by automations).
 *
 * v2 Status lifecycle:
 *   creating → idle → active → idle → snapshotting → hibernated
 *   hibernated/stopped/failed → (restore/create) → idle → active
 *   Any state → stopped | failed
 */
export const interactiveSessions = pgTable("interactive_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  createdBy: text("created_by").notNull(),

  // Agent config
  agentType: text("agent_type").notNull().default("claude"),
  agentSecretId: uuid("agent_secret_id").references(() => secrets.id),
  keyPoolId: uuid("key_pool_id").references(() => keyPools.id),
  repositoryId: uuid("repository_id").references(() => repositories.id),
  prompt: text("prompt").notNull(),
  model: text("model"),
  modelParams: jsonb("model_params").$type<ModelParams>().default({}).notNull(),

  // Runtime state
  status: text("status").default("creating").notNull(),
  sdkSessionId: text("sdk_session_id"),
  sandboxId: text("sandbox_id"),
  sandboxBaseUrl: text("sandbox_base_url"),

  // v2: Epoch fencing — monotonically increasing, incremented on each sandbox create/restore
  epoch: integer("epoch").notNull().default(0),

  // Session continuation
  nativeAgentSessionId: text("native_agent_session_id"),
  cwd: text("cwd"),
  latestCheckpointId: uuid("latest_checkpoint_id"),
  // FK to interactive_session_checkpoints added after that table is created (circular dep)

  // Results
  summary: text("summary"),
  error: text("error"),

  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}, (table) => [
  index("idx_interactive_sessions_key_pool").on(table.keyPoolId),
  check(
    "chk_sessions_key_source",
    sql`${table.agentSecretId} IS NULL OR ${table.keyPoolId} IS NULL`,
  ),
]);

/**
 * One row per sandbox lifecycle within a conversation.
 * Tracks sandbox/task/server state separately from the logical session.
 */
export const interactiveSessionRuntimes = pgTable(
  "interactive_session_runtimes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id").notNull(),
    sandboxId: text("sandbox_id"),
    sandboxBaseUrl: text("sandbox_base_url"),
    agentServerUrl: text("agent_server_url"), // sandbox-agent server URL (port 2468) for process logs
    sdkSessionId: text("sdk_session_id"),
    epoch: integer("epoch").notNull(), // Session epoch at creation time — fencing token
    restoreSource: text("restore_source").notNull(), // 'base_snapshot' | 'hibernate_snapshot' | 'fresh'
    restoreSnapshotId: text("restore_snapshot_id"),
    status: text("status").default("creating").notNull(), // creating | running | idle | stopped | failed
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    // Enforce: only one live runtime per session
    uniqueIndex("idx_one_live_runtime_per_session")
      .on(table.sessionId)
      .where(sql`status IN ('creating', 'running', 'idle')`),
    foreignKey({
      name: "interactive_session_runtimes_session_fk",
      columns: [table.sessionId],
      foreignColumns: [interactiveSessions.id],
    }),
  ],
);

/**
 * Hibernation snapshots — one row per Vercel sandbox snapshot.
 */
export const interactiveSessionCheckpoints = pgTable(
  "interactive_session_checkpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id").notNull(),
    runtimeId: uuid("runtime_id"),
    snapshotId: text("snapshot_id").notNull(),
    baseCommitSha: text("base_commit_sha"),
    lastEventIndex: integer("last_event_index"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "interactive_session_checkpoints_session_fk",
      columns: [table.sessionId],
      foreignColumns: [interactiveSessions.id],
    }),
    foreignKey({
      name: "interactive_session_checkpoints_runtime_fk",
      columns: [table.runtimeId],
      foreignColumns: [interactiveSessionRuntimes.id],
    }),
  ],
);

/**
 * Turn-level tracking for interactive sessions.
 * Each prompt→response cycle is one turn.
 * Enables the continuous-pr-review orchestrator to wait for turn completion
 * and extract the final assistant message.
 */
export const interactiveSessionTurns = pgTable(
  "interactive_session_turns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => interactiveSessions.id, { onDelete: "cascade" }),
    runtimeId: uuid("runtime_id"),
    // v2: Link turns to the job system for correlation
    jobId: uuid("job_id"),
    attemptId: uuid("attempt_id"),
    requestId: text("request_id").notNull(),
    source: text("source").notNull(), // 'user' | 'automation'
    status: text("status").default("pending").notNull(), // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
    prompt: text("prompt").notNull(),
    finalMessage: text("final_message"),
    error: text("error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_interactive_session_turn_request").on(
      table.sessionId,
      table.requestId,
    ),
    index("idx_interactive_session_turn_status").on(
      table.sessionId,
      table.status,
    ),
    foreignKey({
      name: "interactive_session_turns_runtime_fk",
      columns: [table.runtimeId],
      foreignColumns: [interactiveSessionRuntimes.id],
    }).onDelete("set null"),
  ],
);
