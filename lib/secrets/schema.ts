import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    provider: text("provider").notNull(), // 'anthropic' | 'openai'
    label: text("label").notNull(), // User label: 'prod', 'staging', etc.
    encryptedValue: text("encrypted_value").notNull(),
    createdBy: text("created_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.organizationId, t.provider, t.label)],
);
