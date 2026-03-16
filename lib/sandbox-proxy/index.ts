/**
 * Sandbox REST Proxy — Entry Point
 *
 * Runs inside the Vercel Sandbox alongside sandbox-agent (port 2468).
 * This proxy listens on port 2469 and translates REST → ACP.
 *
 * Usage: node proxy.js
 *
 * Environment variables:
 *   PROXY_PORT     — HTTP port (default: 2469)
 *   DATABASE_URL   — Postgres connection for persist driver
 */

import { ensureOutboxDir } from "./outbox";
import { ProxyServer } from "./server";

// Conditionally import persist driver — may not be available in all environments
let persist: import("sandbox-agent").SessionPersistDriver | undefined;
try {
  if (process.env.DATABASE_URL) {
    // Dynamic import to avoid hard dependency
    const { PostgresSessionPersistDriver } = await import(
      "@sandbox-agent/persist-postgres"
    );
    persist = new PostgresSessionPersistDriver({
      connectionString: process.env.DATABASE_URL,
      schema: "sandbox_agent",
    });
  }
} catch (err) {
  console.warn(
    "[proxy] Failed to initialize persist driver — events won't be persisted:",
    err instanceof Error ? err.message : err,
  );
}

// Ensure outbox directory exists
ensureOutboxDir();

// Start the proxy server
const port = parseInt(process.env.PROXY_PORT ?? "2469", 10);
const server = new ProxyServer(persist);
await server.start(port);

console.log(`[proxy] Sandbox REST Proxy started on port ${port}`);

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[proxy] Received SIGTERM, shutting down");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[proxy] Received SIGINT, shutting down");
  process.exit(0);
});
