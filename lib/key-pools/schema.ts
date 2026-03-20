import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { secrets } from "@/lib/secrets/schema";

export const keyPools = pgTable(
  "key_pools",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    provider: text("provider").notNull(), // 'anthropic' | 'openai'
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.organizationId, t.name),
    index("idx_key_pools_org").on(t.organizationId),
  ],
);

export const keyPoolMembers = pgTable(
  "key_pool_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => keyPools.id, { onDelete: "cascade" }),
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secrets.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").default(true).notNull(),
    lastSelectedAt: timestamp("last_selected_at", { withTimezone: true }),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.poolId, t.secretId),
    index("idx_key_pool_members_pool").on(t.poolId),
    index("idx_key_pool_members_selection").on(t.poolId, t.enabled, t.lastSelectedAt),
  ],
);
