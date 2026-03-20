/**
 * Sandbox REST Proxy — Agent Health Monitor
 *
 * Polls the sandbox-agent server at localhost:2468/v1/health.
 * Provides an AbortSignal that fires when the agent is unreachable.
 */

import { proxyLog } from "./logger";

const HEALTH_URL = "http://localhost:2468/v1/health";
const CHECK_INTERVAL_MS = 10_000; // 10s
const MAX_CONSECUTIVE_FAILURES = 2;

export class AgentMonitor {
  private controller: AbortController;
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private totalChecks = 0;
  private failedChecks = 0;

  constructor() {
    this.controller = new AbortController();
  }

  /** AbortSignal that fires when the agent is considered dead. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Aggregate health check stats for metrics. */
  get stats(): { total: number; failed: number } {
    return { total: this.totalChecks, failed: this.failedChecks };
  }

  /** Start periodic health checks. */
  start(): void {
    if (this.timer) return;
    this.consecutiveFailures = 0;

    this.timer = setInterval(async () => {
      this.totalChecks++;
      const checkStart = Date.now();

      try {
        const res = await fetch(HEALTH_URL, {
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          this.consecutiveFailures = 0;
        } else {
          this.consecutiveFailures++;
          this.failedChecks++;
          proxyLog.warn("health_check_failed", {
            status: res.status,
            consecutiveFailures: this.consecutiveFailures,
            latencyMs: Date.now() - checkStart,
          });
        }
      } catch (err) {
        this.consecutiveFailures++;
        this.failedChecks++;
        proxyLog.warn("health_check_error", {
          error: err instanceof Error ? err.message : String(err),
          consecutiveFailures: this.consecutiveFailures,
          latencyMs: Date.now() - checkStart,
        });
      }

      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        proxyLog.error("agent_unreachable", {
          consecutiveFailures: this.consecutiveFailures,
          totalChecks: this.totalChecks,
          failedChecks: this.failedChecks,
        });
        this.controller.abort(
          new Error("Sandbox agent unreachable — health check failed"),
        );
        this.stop();
      }
    }, CHECK_INTERVAL_MS);

    // Don't prevent Node.js from exiting due to this timer
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  /** Stop health checks. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Reset for a new prompt execution. */
  reset(): void {
    this.stop();
    this.controller = new AbortController();
    this.consecutiveFailures = 0;
    this.totalChecks = 0;
    this.failedChecks = 0;
  }
}
