/**
 * Sandbox REST Proxy — Structured Logger
 *
 * Minimal JSON logger that bundles with esbuild. No external dependencies.
 * Outputs one JSON line per log entry to stdout/stderr.
 */

import fs from "node:fs";
import path from "node:path";
import type { ProxyLogEntry, ProxyLogLevel } from "./types";

type LogContext = {
  sessionId?: string;
  runtimeId?: string;
  sandboxId?: string;
  rawLogDebugEnabled?: boolean;
  rawLogDebugExpiresAt?: string;
  jobId?: string;
  attemptId?: string;
  epoch?: number;
};

type LogPayload = Record<string, unknown>;
type LogDrain = {
  submit(entry: ProxyLogEntry): void;
  flush(): Promise<void>;
};

let globalContext: LogContext = {};
const LOG_BUFFER_LIMIT = 200;
const LOG_DIR = "/tmp/polaris-proxy";
const LOG_FILE_PATH = path.join(LOG_DIR, "proxy.log.ndjson");
const LOG_FILE_ROTATED_PATH = path.join(LOG_DIR, "proxy.log.1.ndjson");
const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024;
const logBuffer: ProxyLogEntry[] = [];
let logDrain: LogDrain | null = null;

function appendToLocalLog(line: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const currentSize = fs.existsSync(LOG_FILE_PATH)
      ? fs.statSync(LOG_FILE_PATH).size
      : 0;
    if (currentSize >= LOG_FILE_MAX_BYTES) {
      try {
        if (fs.existsSync(LOG_FILE_ROTATED_PATH)) fs.unlinkSync(LOG_FILE_ROTATED_PATH);
      } catch {
        // Best-effort rotation
      }
      fs.renameSync(LOG_FILE_PATH, LOG_FILE_ROTATED_PATH);
    }
    fs.appendFileSync(LOG_FILE_PATH, line + "\n");
  } catch {
    // Best-effort file sink
  }
}

function emit(level: ProxyLogLevel, msg: string, data?: LogPayload): void {
  const entry: ProxyLogEntry = {
    ts: new Date().toISOString(),
    level,
    component: "proxy",
    ...globalContext,
    msg,
    ...data,
  };

  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_LIMIT) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_LIMIT);
  }

  const line = JSON.stringify(entry);
  appendToLocalLog(line);
  logDrain?.submit(entry);
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const proxyLog = {
  /** Set context fields included in every subsequent log entry. */
  setContext(ctx: LogContext): void {
    globalContext = { ...globalContext, ...ctx };
  },

  /** Clear all context (e.g., when prompt completes). */
  clearContext(): void {
    globalContext = {};
  },

  setDrain(drain: LogDrain | null): void {
    logDrain = drain;
  },

  async flush(): Promise<void> {
    await logDrain?.flush();
  },

  getLogFilePath(): string {
    return LOG_FILE_PATH;
  },

  getRotatedLogFilePath(): string {
    return LOG_FILE_ROTATED_PATH;
  },

  getRecentEntries(limit: number = 20): ProxyLogEntry[] {
    if (limit <= 0) return [];
    return logBuffer.slice(-limit);
  },

  info(msg: string, data?: LogPayload): void {
    emit("info", msg, data);
  },

  warn(msg: string, data?: LogPayload): void {
    emit("warn", msg, data);
  },

  error(msg: string, data?: LogPayload): void {
    emit("error", msg, data);
  },
};
