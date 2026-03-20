import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionEventBatcher, reconstructOutput, type DriverEvent } from "@/lib/sandbox-proxy/event-batcher";

function makeEvent(payload: Record<string, unknown> = {}): { eventIndex: number; sender: string; payload: Record<string, unknown> } {
  return { eventIndex: 0, sender: "agent", payload };
}

function makeTextEvent(text: string): { eventIndex: number; sender: string; payload: Record<string, unknown> } {
  return makeEvent({
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } },
  });
}

function makeToolCallEvent(): { eventIndex: number; sender: string; payload: Record<string, unknown> } {
  return makeEvent({
    params: { update: { sessionUpdate: "tool_call" } },
  });
}

describe("SessionEventBatcher", () => {
  let flushFn: (sessionId: string, events: DriverEvent[]) => Promise<void>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushFn = vi.fn<(sessionId: string, events: DriverEvent[]) => Promise<void>>().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("assigns monotonic eventIndex starting from 0 by default", async () => {
    const batcher = new SessionEventBatcher("sess-1", "conn-1", flushFn, { flushIntervalMs: 10000 });
    batcher.push(makeEvent());
    batcher.push(makeEvent());
    batcher.push(makeEvent());

    expect(batcher.collected[0].eventIndex).toBe(0);
    expect(batcher.collected[1].eventIndex).toBe(1);
    expect(batcher.collected[2].eventIndex).toBe(2);
    await batcher.finalize();
  });

  it("assigns monotonic eventIndex starting from nextEventIndex", async () => {
    const batcher = new SessionEventBatcher("sess-1", "conn-1", flushFn, {
      nextEventIndex: 42,
      flushIntervalMs: 10000,
    });
    batcher.push(makeEvent());
    batcher.push(makeEvent());

    expect(batcher.collected[0].eventIndex).toBe(42);
    expect(batcher.collected[1].eventIndex).toBe(43);
    await batcher.finalize();
  });

  it("generates deterministic event IDs from sessionId + eventIndex", async () => {
    const batcher = new SessionEventBatcher("my-session", "conn-1", flushFn, { flushIntervalMs: 10000 });
    batcher.push(makeEvent());
    batcher.push(makeEvent());

    expect(batcher.collected[0].id).toBe("my-session-0");
    expect(batcher.collected[1].id).toBe("my-session-1");
    await batcher.finalize();
  });

  it("sets sessionId and connectionId on all events", async () => {
    const batcher = new SessionEventBatcher("sess-abc", "attempt-xyz", flushFn, { flushIntervalMs: 10000 });
    batcher.push(makeEvent());

    expect(batcher.collected[0].sessionId).toBe("sess-abc");
    expect(batcher.collected[0].connectionId).toBe("attempt-xyz");
    await batcher.finalize();
  });

  it("flushes at batch size threshold", async () => {
    const batcher = new SessionEventBatcher("sess-1", "conn-1", flushFn, {
      batchSize: 3,
      flushIntervalMs: 10000,
    });

    batcher.push(makeEvent());
    batcher.push(makeEvent());
    expect(flushFn).not.toHaveBeenCalled();

    batcher.push(makeEvent()); // hits threshold
    // flush is async, await a tick
    await vi.advanceTimersByTimeAsync(0);
    expect(flushFn).toHaveBeenCalledTimes(1);
    expect(flushFn).toHaveBeenCalledWith("sess-1", expect.arrayContaining([
      expect.objectContaining({ eventIndex: 0 }),
      expect.objectContaining({ eventIndex: 1 }),
      expect.objectContaining({ eventIndex: 2 }),
    ]));
    await batcher.finalize();
  });

  it("force flush returns all unflushed events", async () => {
    const batcher = new SessionEventBatcher("sess-1", "conn-1", flushFn, {
      batchSize: 100,
      flushIntervalMs: 10000,
    });

    batcher.push(makeEvent());
    batcher.push(makeEvent());
    expect(flushFn).not.toHaveBeenCalled();

    await batcher.finalize();
    expect(flushFn).toHaveBeenCalledTimes(1);
    expect(flushFn).toHaveBeenCalledWith("sess-1", expect.arrayContaining([
      expect.objectContaining({ eventIndex: 0 }),
      expect.objectContaining({ eventIndex: 1 }),
    ]));
  });

  it("eventCount tracks total collected events", async () => {
    const batcher = new SessionEventBatcher("sess-1", "conn-1", flushFn, { flushIntervalMs: 10000 });
    expect(batcher.eventCount).toBe(0);
    batcher.push(makeEvent());
    batcher.push(makeEvent());
    expect(batcher.eventCount).toBe(2);
    await batcher.finalize();
  });
});

describe("reconstructOutput", () => {
  function makeDriverEvents(specs: Array<{ type: "text"; text: string } | { type: "tool_call" }>): DriverEvent[] {
    return specs.map((spec, i) => ({
      id: `test-${i}`,
      eventIndex: i,
      sessionId: "sess-1",
      createdAt: Date.now(),
      connectionId: "conn-1",
      sender: "agent",
      payload: spec.type === "text"
        ? { params: { update: { sessionUpdate: "agent_message_chunk", content: { text: spec.text } } } }
        : { params: { update: { sessionUpdate: "tool_call" } } },
    }));
  }

  it("reconstructs single text block", () => {
    const events = makeDriverEvents([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);
    const result = reconstructOutput(events);
    expect(result.allOutput).toBe("Hello world");
    expect(result.lastMessage).toBe("Hello world");
  });

  it("splits on tool call boundaries", () => {
    const events = makeDriverEvents([
      { type: "text", text: "First part" },
      { type: "tool_call" },
      { type: "text", text: "Second part" },
    ]);
    const result = reconstructOutput(events);
    expect(result.allOutput).toBe("First part\n\nSecond part");
    expect(result.lastMessage).toBe("Second part");
  });

  it("handles multiple interleaved tool calls", () => {
    const events = makeDriverEvents([
      { type: "text", text: "A" },
      { type: "tool_call" },
      { type: "text", text: "B" },
      { type: "tool_call" },
      { type: "text", text: "C" },
    ]);
    const result = reconstructOutput(events);
    expect(result.allOutput).toBe("A\n\nB\n\nC");
    expect(result.lastMessage).toBe("C");
  });

  it("returns empty for no events", () => {
    const result = reconstructOutput([]);
    expect(result.allOutput).toBe("");
    expect(result.lastMessage).toBeUndefined();
  });

  it("handles events with no text content", () => {
    const events = makeDriverEvents([
      { type: "tool_call" },
      { type: "tool_call" },
    ]);
    const result = reconstructOutput(events);
    expect(result.allOutput).toBe("");
    expect(result.lastMessage).toBeUndefined();
  });
});
