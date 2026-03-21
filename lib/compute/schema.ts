/**
 * Compute Claims Schema
 *
 * A claim declares: "this claimant needs a running sandbox for this session
 * until the claim is released or expires." The runtime controller reads
 * active claims to decide whether a sandbox should exist.
 *
 * Claims decouple intent ("I need compute") from execution ("a sandbox exists").
 * Consumers create/release claims. Only the controller touches Vercel.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { interactiveSessions } from "@/lib/sessions/schema";

export const computeClaims = pgTable(
  "compute_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** The session whose sandbox this claim is for. */
    sessionId: uuid("session_id").notNull(),

    /** Who holds this claim — a job ID, 'interactive', or 'postprocess:<jobId>'. */
    claimant: text("claimant").notNull(),

    /** Why the sandbox is needed. */
    reason: text("reason").notNull(), // 'job_active' | 'postprocess_finalizer' | 'interactive_attached' | 'queued_review'

    /** Hard deadline — claim auto-expires if not released. Safety net. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /** When the claim was explicitly released (null = still active). */
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    // Fast lookup: active claims for a session
    index("idx_compute_claims_session_active")
      .on(table.sessionId)
      .where(sql`released_at IS NULL`),

    // Sweeper: find expired claims
    index("idx_compute_claims_expired")
      .on(table.expiresAt)
      .where(sql`released_at IS NULL`),

    foreignKey({
      name: "compute_claims_session_fk",
      columns: [table.sessionId],
      foreignColumns: [interactiveSessions.id],
    }),
  ],
);
