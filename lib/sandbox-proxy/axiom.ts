import type { ProxyLogEntry } from "./types";

const DEFAULT_INGEST_URL = "https://api.axiom.co";
const FLUSH_INTERVAL_MS = 2_000;
const MAX_BATCH_SIZE = 50;
const MAX_QUEUE_SIZE = 1_000;

type AxiomConfig = {
  ingestUrl: string;
  dataset: string;
};

export class AxiomLogDrain {
  private queue: ProxyLogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly config: AxiomConfig) {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);

    if (typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      this.flushTimer.unref();
    }
  }

  submit(entry: ProxyLogEntry): void {
    this.queue.push(entry);
    if (this.queue.length > MAX_QUEUE_SIZE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE_SIZE);
    }
    if (this.queue.length >= MAX_BATCH_SIZE) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      return;
    }
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, MAX_BATCH_SIZE);
    const endpoint = `${this.config.ingestUrl.replace(/\/$/, "")}/v1/ingest/${encodeURIComponent(this.config.dataset)}`;

    this.inflight = fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Axiom ingest failed with ${response.status}`);
        }
      })
      .catch((error) => {
        this.queue.unshift(...batch);
        if (this.queue.length > MAX_QUEUE_SIZE) {
          this.queue.splice(MAX_QUEUE_SIZE);
        }
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[proxy] axiom_ingest_failed ${message}\n`,
        );
      })
      .finally(() => {
        this.inflight = null;
      });

    await this.inflight;
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

export function createAxiomLogDrainFromEnv(): AxiomLogDrain | null {
  const dataset = process.env.AXIOM_PROXY_DATASET;
  if (!dataset) return null;

  return new AxiomLogDrain({
    ingestUrl: process.env.AXIOM_PROXY_INGEST_URL ?? DEFAULT_INGEST_URL,
    dataset,
  });
}
