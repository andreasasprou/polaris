/**
 * Sandbox REST Proxy — Agent Health Monitor
 *
 * Polls the sandbox-agent server at localhost:2468/v1/health.
 * Provides an AbortSignal that fires when the agent is unreachable.
 */

const HEALTH_URL = "http://localhost:2468/v1/health";
const CHECK_INTERVAL_MS = 10_000; // 10s
const MAX_CONSECUTIVE_FAILURES = 2;

export class AgentMonitor {
  private controller: AbortController;
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;

  constructor() {
    this.controller = new AbortController();
  }

  /** AbortSignal that fires when the agent is considered dead. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Start periodic health checks. */
  start(): void {
    if (this.timer) return;
    this.consecutiveFailures = 0;

    this.timer = setInterval(async () => {
      try {
        const res = await fetch(HEALTH_URL, {
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          this.consecutiveFailures = 0;
        } else {
          this.consecutiveFailures++;
        }
      } catch {
        this.consecutiveFailures++;
      }

      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `[proxy] Agent health check failed ${this.consecutiveFailures} times — aborting`,
        );
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
  }
}
