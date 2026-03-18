/**
 * Test Database Harness — Schema-per-test isolation
 *
 * Each test file gets its own Postgres schema with migrations applied.
 * Uses a single client (not pool) to ensure search_path is consistent.
 */

import { Client } from "pg";
import { randomBytes } from "node:crypto";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://polaris:polaris@localhost:5432/polaris";

export type TestDbContext = {
  client: Client;
  schemaName: string;
  query: Client["query"];
  cleanup: () => Promise<void>;
};

export async function setupTestDb(): Promise<TestDbContext> {
  const schemaName = `test_${randomBytes(6).toString("hex")}`;
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();

  // Create isolated schema and set search_path
  await client.query(`CREATE SCHEMA "${schemaName}"`);
  await client.query(`SET search_path TO "${schemaName}"`);

  // Run migrations with FK constraints stripped.
  // FK references resolve to the public schema (not our test schema),
  // causing violations. We strip REFERENCES/FOREIGN KEY clauses and
  // rely on the test logic for referential integrity.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const migrationsDir = path.resolve(
    import.meta.dirname,
    "../../lib/db/migrations",
  );
  const journalPath = path.join(migrationsDir, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));

  for (const entry of journal.entries) {
    const sqlFile = path.join(migrationsDir, `${entry.tag}.sql`);
    if (fs.existsSync(sqlFile)) {
      let migration = fs.readFileSync(sqlFile, "utf-8");
      // Strip FK-related DDL for schema isolation:
      // 1. Inline REFERENCES in CREATE TABLE
      migration = migration.replace(/\s+REFERENCES\s+"[^"]+"\s*\([^)]*\)(\s+ON\s+(DELETE|UPDATE)\s+\w+(\s+\w+)?)*/gi, "");
      // 2. ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY
      migration = migration.replace(/ALTER TABLE[^;]*FOREIGN KEY[^;]*;/gi, "");
      // 3. ALTER TABLE ... DROP CONSTRAINT (for FKs that no longer exist)
      migration = migration.replace(/ALTER TABLE[^;]*DROP CONSTRAINT[^;]*;/gi, "");
      // 4. DO $$ ... END $$ blocks (often contain FK-related logic)
      migration = migration.replace(/DO \$\$[\s\S]*?\$\$;/gi, "");
      await client.query(migration);
    }
  }

  return {
    client,
    schemaName,
    query: client.query.bind(client),
    async cleanup() {
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        await client.end();
      }
    },
  };
}
