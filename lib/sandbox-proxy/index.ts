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
import { createAxiomLogDrainFromEnv } from "./axiom";
import { proxyLog } from "./logger";
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
const axiomDrain = createAxiomLogDrainFromEnv();
proxyLog.setDrain(axiomDrain);
proxyLog.setContext({
  sessionId: process.env.POLARIS_SESSION_ID,
  runtimeId: process.env.POLARIS_RUNTIME_ID,
  sandboxId: process.env.POLARIS_SANDBOX_ID,
  rawLogDebugEnabled: process.env.POLARIS_RAW_LOG_DEBUG === "true",
  rawLogDebugExpiresAt: process.env.POLARIS_RAW_LOG_DEBUG_EXPIRES_AT,
});

// Start the proxy server
const port = parseInt(process.env.PROXY_PORT ?? "2469", 10);
const server = new ProxyServer(persist);
await server.start(port);

console.log(`[proxy] Sandbox REST Proxy started on port ${port}`);

async function flushAndExit(code: number): Promise<never> {
  axiomDrain?.stop();
  await proxyLog.flush().catch(() => {});
  process.exit(code);
}

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[proxy] Received SIGTERM, shutting down");
  void flushAndExit(0);
});

process.on("SIGINT", () => {
  console.log("[proxy] Received SIGINT, shutting down");
  void flushAndExit(0);
});

process.on("beforeExit", () => {
  axiomDrain?.stop();
  return proxyLog.flush();
});

process.on("uncaughtException", (error) => {
  console.error("[proxy] Uncaught exception:", error);
  void flushAndExit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[proxy] Unhandled rejection:", reason);
  void flushAndExit(1);
});
