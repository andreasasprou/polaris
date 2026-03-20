/**
 * Sandbox REST Proxy — Session Event Batcher
 *
 * Collects agent events during prompt execution, assigns driver-compatible
 * metadata (monotonic eventIndex, deterministic id, sessionId, connectionId),
 * and flushes batches via callback for platform-side persistence.
 *
 * This replaces in-sandbox DB persistence — the sandbox never has DATABASE_URL.
 */

import type { AgentEvent } from "./types";

/** Driver-compatible event shape matching @sandbox-agent/persist-postgres schema. */
export type DriverEvent = {
  id: string;
  eventIndex: number;
  sessionId: string;
  createdAt: number;
  connectionId: string;
  sender: string;
  payload: Record<string, unknown>;
};

type FlushFn = (sessionId: string, events: DriverEvent[]) => Promise<void>;

type IndexedEntry =
  | { type: "text"; eventIndex: number; text: string }
  | { type: "boundary"; eventIndex: number };

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_FLUSH_INTERVAL_MS = 250;

export class SessionEventBatcher {
  private buffer: DriverEvent[] = [];
  private allCollected: DriverEvent[] = [];
  private nextIndex: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly connectionId: string,
    private readonly flushFn: FlushFn,
    opts?: {
      nextEventIndex?: number;
      batchSize?: number;
      flushIntervalMs?: number;
    },
  ) {
    this.nextIndex = opts?.nextEventIndex ?? 0;
    const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
    const intervalMs = opts?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    // Periodic flush timer
    this.timer = setInterval(() => {
      if (this.buffer.length > 0) {
        this.flush().catch(() => {});
      }
    }, intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }

    // Auto-flush at batch size threshold
    this._batchSize = batchSize;
  }

  private _batchSize: number;

  /** Add a raw agent event, assigning driver-compatible metadata. */
  push(event: AgentEvent): void {
    const driverEvent: DriverEvent = {
      id: `${this.sessionId}-${this.nextIndex}`,
      eventIndex: this.nextIndex,
      sessionId: this.sessionId,
      createdAt: Date.now(),
      connectionId: this.connectionId,
      sender: event.sender ?? "agent",
      payload: event.payload,
    };
    this.nextIndex++;
    this.buffer.push(driverEvent);
    this.allCollected.push(driverEvent);

    if (this.buffer.length >= this._batchSize) {
      this.flush().catch(() => {});
    }
  }

  /** Flush buffered events via the callback. Returns the flushed events. */
  async flush(): Promise<DriverEvent[]> {
    if (this.buffer.length === 0) return [];
    const batch = this.buffer;
    this.buffer = [];
    await this.flushFn(this.sessionId, batch);
    return batch;
  }

  /** Force flush + stop timer. Call before emitting terminal callbacks. */
  async finalize(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** All events collected during this prompt execution (for output reconstruction). */
  get collected(): ReadonlyArray<DriverEvent> {
    return this.allCollected;
  }

  /** Current event count. */
  get eventCount(): number {
    return this.allCollected.length;
  }
}

/**
 * Reconstruct allOutput and lastMessage from collected events.
 * Pure function — same boundary-splitting logic as the old readPersistedOutput.
 */
export function reconstructOutput(events: ReadonlyArray<DriverEvent>): {
  allOutput: string;
  lastMessage: string | undefined;
} {
  const entries: IndexedEntry[] = [];

  for (const event of events) {
    const payload = event.payload;
    const params = payload?.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    const updateType = update?.sessionUpdate as string | undefined;

    if (updateType === "agent_message_chunk") {
      const content = update!.content as { text?: string } | undefined;
      if (content?.text) {
        entries.push({ type: "text", eventIndex: event.eventIndex, text: content.text });
      }
    } else if (updateType === "tool_call" || updateType === "turn_ended") {
      entries.push({ type: "boundary", eventIndex: event.eventIndex });
    }
  }

  if (entries.length === 0) {
    return { allOutput: "", lastMessage: undefined };
  }

  entries.sort((a, b) => a.eventIndex - b.eventIndex);

  const messages: string[] = [];
  let current: string[] = [];

  for (const entry of entries) {
    if (entry.type === "text") {
      current.push(entry.text);
    } else {
      if (current.length > 0) {
        messages.push(current.join(""));
        current = [];
      }
    }
  }
  if (current.length > 0) {
    messages.push(current.join(""));
  }

  const allOutput = messages.join("\n\n");
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
  return { allOutput, lastMessage };
}
