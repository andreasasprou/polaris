import { PostgresSessionPersistDriver } from "@sandbox-agent/persist-postgres";

/**
 * Create a Postgres persist driver for the Sandbox Agent SDK.
 * Uses a dedicated "sandbox_agent" schema to avoid collisions with Drizzle tables.
 * The driver auto-creates its tables on first use.
 */
export function createPersistDriver() {
  return new PostgresSessionPersistDriver({
    connectionString: process.env.DATABASE_URL!,
    schema: "sandbox_agent",
  });
}
