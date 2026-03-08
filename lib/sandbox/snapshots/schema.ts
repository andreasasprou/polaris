import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const sandboxSnapshots = pgTable("sandbox_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
  agentType: text("agent_type").notNull(),
  status: text("status").default("active").notNull(),
  sandboxAgentVersion: text("sandbox_agent_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
