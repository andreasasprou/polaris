import {
  pgTable,
  uuid,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const eventDeliveries = pgTable("event_deliveries", {
  id: uuid("id").defaultRandom().primaryKey(),
  source: text("source").notNull(), // 'github' | 'slack' | 'webhook' | 'sentry'
  externalEventId: text("external_event_id"),
  sourceDeliveryId: text("source_delivery_id"),
  dedupeKey: text("dedupe_key").notNull().unique(),
  organizationId: text("organization_id"),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
