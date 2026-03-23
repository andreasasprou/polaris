/**
 * Sandbox REST Proxy — Agent Health Monitor
 *
 * Polls the sandbox-agent server at localhost:2468/v1/health.
 * Provides an AbortSignal that fires when the agent is unreachable.
 */

import { proxyLog } from "./logger";
import type { AgentHealthSnapshot, AgentHealthStatus } from "./types";

const HEALTH_URL = "http://localhost:2468/v1/health";
const CHECK_INTERVAL_MS = 10_000; // 10s
const MAX_CONSECUTIVE_FAILURES = 2;

export class AgentMonitor {
  private controller: AbortController;
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private totalChecks = 0;
  private failedChecks = 0;
  private status: AgentHealthStatus = "idle";
  private lastCheckAt?: string;
  private lastSuccessAt?: string;
  private lastFailureAt?: string;
  private lastLatencyMs?: number;
  private lastError?: string;
  private abortReason?: string;

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

  /** Current health snapshot for status and diagnostics. */
  get snapshot(): AgentHealthSnapshot {
    return {
      status: this.status,
      totalChecks: this.totalChecks,
      failedChecks: this.failedChecks,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckAt: this.lastCheckAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastLatencyMs: this.lastLatencyMs,
      lastError: this.lastError,
      abortReason: this.abortReason,
    };
  }

  /** Start periodic health checks. */
  start(): void {
    if (this.timer) return;
    this.consecutiveFailures = 0;
    this.status = "starting";

    this.timer = setInterval(async () => {
      this.totalChecks++;
      const checkStart = Date.now();
      this.lastCheckAt = new Date().toISOString();

      try {
        const res = await fetch(HEALTH_URL, {
          signal: AbortSignal.timeout(5_000),
        });
        this.lastLatencyMs = Date.now() - checkStart;
        if (res.ok) {
          this.consecutiveFailures = 0;
          this.status = "healthy";
          this.lastSuccessAt = new Date().toISOString();
          this.lastError = undefined;
        } else {
          this.consecutiveFailures++;
          this.failedChecks++;
          this.status = "degraded";
          this.lastFailureAt = new Date().toISOString();
          this.lastError = `health status ${res.status}`;
          proxyLog.warn("health_check_failed", {
            status: res.status,
            consecutiveFailures: this.consecutiveFailures,
            latencyMs: this.lastLatencyMs,
          });
        }
      } catch (err) {
        this.consecutiveFailures++;
        this.failedChecks++;
        this.lastLatencyMs = Date.now() - checkStart;
        this.status = "degraded";
        this.lastFailureAt = new Date().toISOString();
        this.lastError = err instanceof Error ? err.message : String(err);
        proxyLog.warn("health_check_error", {
          error: this.lastError,
          consecutiveFailures: this.consecutiveFailures,
          latencyMs: this.lastLatencyMs,
        });
      }

      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.status = "unreachable";
        this.abortReason = "Sandbox agent unreachable — health check failed";
        proxyLog.error("agent_unreachable", {
          consecutiveFailures: this.consecutiveFailures,
          totalChecks: this.totalChecks,
          failedChecks: this.failedChecks,
        });
        this.controller.abort(
          new Error(this.abortReason),
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
    this.status = "idle";
    this.lastCheckAt = undefined;
    this.lastSuccessAt = undefined;
    this.lastFailureAt = undefined;
    this.lastLatencyMs = undefined;
    this.lastError = undefined;
    this.abortReason = undefined;
  }
}
