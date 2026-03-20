/**
 * Sandbox REST Proxy — Structured Logger
 *
 * Minimal JSON logger that bundles with esbuild. No external dependencies.
 * Outputs one JSON line per log entry to stdout/stderr.
 */

type LogLevel = "info" | "warn" | "error";

type LogContext = {
  jobId?: string;
  attemptId?: string;
  epoch?: number;
};

type LogPayload = Record<string, unknown>;

let globalContext: LogContext = {};

function emit(level: LogLevel, msg: string, data?: LogPayload): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component: "proxy",
    ...globalContext,
    msg,
    ...data,
  };

  const line = JSON.stringify(entry);
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
