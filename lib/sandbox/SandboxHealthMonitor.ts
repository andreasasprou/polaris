/**
 * Monitors sandbox-agent server health and provides an AbortSignal
 * that fires when the server becomes unreachable.
 *
 * Usage:
 *   const monitor = new SandboxHealthMonitor(serverUrl);
 *   monitor.start();
 *   await executePrompt(session, prompt, { signal: monitor.signal });
 *   monitor.stop();
 *
 * The monitor performs lightweight HTTP health checks at a fixed interval.
 * After `maxConsecutiveFailures` consecutive failures, it aborts the signal —
 * any operations racing against `monitor.signal` will reject immediately.
 */
export class SandboxHealthMonitor {
  private controller = new AbortController();
  private interval: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly serverUrl: string,
    private readonly options: {
      /** How often to check health (ms). Default: 10s */
      intervalMs?: number;
      /** How many consecutive failures before aborting. Default: 2 */
      maxConsecutiveFailures?: number;
      /** Timeout for each health check request (ms). Default: 5s */
      requestTimeoutMs?: number;
    } = {},
  ) {}

  /** AbortSignal that fires when the server is declared dead. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether the monitor has declared the server dead. */
  get isDead(): boolean {
    return this.controller.signal.aborted;
  }

  start(): void {
    if (this.interval) return; // already running

    const intervalMs = this.options.intervalMs ?? 10_000;
    this.interval = setInterval(() => this.check(), intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async check(): Promise<void> {
    const timeoutMs = this.options.requestTimeoutMs ?? 5_000;
    const maxFailures = this.options.maxConsecutiveFailures ?? 2;

    try {
      const response = await fetch(`${this.serverUrl}/v1/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        this.consecutiveFailures = 0;
        return;
      }
    } catch {
      // Network error or timeout — count as failure
    }

    this.consecutiveFailures++;

    if (this.consecutiveFailures >= maxFailures) {
      this.stop();
      this.controller.abort(
        new SandboxUnreachableError(this.consecutiveFailures),
      );
    }
  }
}

export class SandboxUnreachableError extends Error {
  constructor(failureCount: number) {
    super(
      `Sandbox agent server unreachable after ${failureCount} consecutive health check failures`,
    );
    this.name = "SandboxUnreachableError";
  }
}
