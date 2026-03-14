import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Org-level environment variables injected into all sandbox sessions.
 * Values are encrypted at rest (AES-256-GCM, same as secrets).
 */
export const sandboxEnvVars = pgTable(
  "sandbox_env_vars",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    key: text("key").notNull(), // e.g. "OPENAI_API_KEY", "DATABASE_URL"
    encryptedValue: text("encrypted_value").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique().on(t.organizationId, t.key)],
);
