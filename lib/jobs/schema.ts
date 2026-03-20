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
import { sql } from "drizzle-orm";
import { interactiveSessions } from "@/lib/sessions/schema";
import { automations, automationRuns } from "@/lib/automations/schema";

/**
 * Jobs — coordination record for all async work.
 * One job per prompt, review, coding task, etc.
 *
 * Status lifecycle:
 *   pending → accepted → running → agent_completed → postprocess_pending → completed
 *   Any state → failed_retryable → pending (retry)
 *   Any state → failed_terminal | cancelled
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),

    // What kind of work
    type: text("type").notNull(),
    // Values: 'prompt', 'review', 'coding_task', 'snapshot', 'pr_create'

    // Links
    sessionId: uuid("session_id").references(() => interactiveSessions.id),
    automationId: uuid("automation_id").references(() => automations.id),
    automationRunId: uuid("automation_run_id").references(() => automationRuns.id),
    requestId: text("request_id"), // Idempotency key (source-specific)

    // State
    status: text("status").default("pending").notNull(),
    // Values: pending, accepted, running, agent_completed,
    //         postprocess_pending, completed,
    //         failed_retryable, failed_terminal, cancelled

    // Configuration
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    maxAttempts: integer("max_attempts").notNull().default(3),
    timeoutSeconds: integer("timeout_seconds").notNull().default(1200),

    // Security (dedicated column — never in payload to avoid log leakage)
    hmacKey: text("hmac_key"),

    // Result (populated on agent_completed)
    result: jsonb("result").$type<Record<string, unknown>>(),

    // Side effect tracking (idempotency for post-processing)
    sideEffectsCompleted: jsonb("side_effects_completed")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    // Timing
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
  },
  (table) => [
    // Same prompt can't be dispatched twice for the same session
    uniqueIndex("idx_jobs_request_id").on(table.sessionId, table.requestId),
    // Fast lookup of active jobs (exclude terminal)
    index("idx_jobs_status").on(table.status).where(
      sql`status NOT IN ('completed', 'failed_terminal', 'cancelled')`,
    ),
    // Sweeper: find jobs past timeout
    index("idx_jobs_timeout").on(table.timeoutAt).where(
      sql`status IN ('accepted', 'running')`,
    ),
    index("idx_jobs_session").on(table.sessionId),
    index("idx_jobs_automation").on(table.automationId),
  ],
);

/**
 * Job attempts — one row per execution attempt.
 * A job with max_attempts: 3 can have up to 3 attempt rows.
 *
 * Status lifecycle:
 *   dispatching → accepted → running → completed
 *   dispatching → dispatch_unknown (timeout — sweeper reconciles)
 *   running → waiting_human → running (HITL)
 *   Any → failed
 */
export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    epoch: integer("epoch").notNull(), // Session epoch at time of attempt
    sandboxId: text("sandbox_id"), // Which sandbox ran this attempt
    resolvedSecretId: uuid("resolved_secret_id"), // Audit: which key was actually used (pool rotation)

    // State
    status: text("status").default("dispatching").notNull(),
    // Values: dispatching, dispatch_unknown, accepted, running,
    //         waiting_human, completed, failed

    // Result
    resultPayload: jsonb("result_payload").$type<Record<string, unknown>>(),
    error: text("error"),

    // Liveness
    lastProgressAt: timestamp("last_progress_at", { withTimezone: true }),

    // Timing
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_job_attempt_unique").on(table.jobId, table.attemptNumber),
    index("idx_job_attempts_job").on(table.jobId),
    index("idx_job_attempts_epoch").on(table.epoch),
  ],
);

/**
 * Callback inbox — idempotent callback ingestion.
 * Same pattern as event_deliveries.
 *
 * Dedupe key is callback_id (sandbox-generated UUID per emission),
 * NOT callback_type — one attempt can emit multiple callbacks of the same type
 * (e.g. multiple permission_requested events).
 */
export const callbackInbox = pgTable(
  "callback_inbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => jobAttempts.id, { onDelete: "cascade" }),
    epoch: integer("epoch").notNull(),

    // Sandbox-generated UUID — unique per emission
    callbackId: text("callback_id").notNull(),

    // Payload
    callbackType: text("callback_type").notNull(),
    // Values: 'prompt_accepted', 'prompt_complete', 'prompt_failed',
    //         'permission_requested', 'question_requested', 'permission_resumed'
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    // Processing
    processed: boolean("processed").notNull().default(false),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processError: text("process_error"),

    // Timing
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Dedupe: same callback can't be ingested twice
    uniqueIndex("idx_callback_inbox_dedupe").on(
      table.jobId,
      table.attemptId,
      table.epoch,
      table.callbackId,
    ),
  ],
);

/**
 * Job events — append-only audit log for state transitions.
 * Not used for control flow — used for debugging, timeline reconstruction,
 * and observability.
 */
export const jobEvents = pgTable(
  "job_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attemptId: uuid("attempt_id").references(() => jobAttempts.id, {
      onDelete: "cascade",
    }),

    eventType: text("event_type").notNull(),
    // Values: 'created', 'dispatched', 'dispatch_unknown', 'accepted', 'running',
    //         'waiting_human', 'resumed', 'agent_completed', 'postprocess_started',
    //         'postprocess_failed', 'completed', 'failed', 'cancelled', 'timeout'

    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_job_events_job").on(table.jobId, table.createdAt),
  ],
);
