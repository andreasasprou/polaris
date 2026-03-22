/**
 * Unit Test: endStaleRuntimes destroys Vercel sandboxes
 *
 * Regression test for the sandbox leak bug. Verifies that the real
 * endStaleRuntimes function calls SandboxManager.destroyById for
 * each stale runtime's sandbox before marking DB records as failed.
 *
 * Uses vitest mocks to replace the DB and SandboxManager dependencies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Track all mock calls
const destroyByIdMock = vi.fn().mockResolvedValue(undefined);
const selectWhereMock = vi.fn();
const updateWhereMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/db", () => {
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: selectWhereMock,
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: updateWhereMock,
        })),
      })),
    },
  };
});

vi.mock("@/lib/sandbox/SandboxManager", () => ({
  SandboxManager: class {
    destroyById = destroyByIdMock;
  },
}));

// Import AFTER mocks are set up (vitest hoists vi.mock automatically)
const { endStaleRuntimes } = await import("@/lib/sessions/actions");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("endStaleRuntimes", () => {
  it("calls destroyById for each stale runtime sandbox", async () => {
    selectWhereMock.mockResolvedValueOnce([
      { id: "rt-1", sandboxId: "sbx-aaa" },
      { id: "rt-2", sandboxId: "sbx-bbb" },
    ]);

    await endStaleRuntimes("session-123");

    expect(destroyByIdMock).toHaveBeenCalledTimes(2);
    expect(destroyByIdMock).toHaveBeenCalledWith("sbx-aaa");
    expect(destroyByIdMock).toHaveBeenCalledWith("sbx-bbb");
  });

  it("marks DB records as failed after destroying sandboxes", async () => {
    selectWhereMock.mockResolvedValueOnce([
      { id: "rt-1", sandboxId: "sbx-aaa" },
    ]);

    await endStaleRuntimes("session-123");

    // DB update should have been called (to mark records as failed)
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
  });

  it("skips null sandboxIds when destroying", async () => {
    selectWhereMock.mockResolvedValueOnce([
      { id: "rt-1", sandboxId: null },
      { id: "rt-2", sandboxId: "sbx-ccc" },
    ]);

    await endStaleRuntimes("session-123");

    expect(destroyByIdMock).toHaveBeenCalledTimes(1);
    expect(destroyByIdMock).toHaveBeenCalledWith("sbx-ccc");
  });

  it("is a no-op when no stale runtimes exist", async () => {
    selectWhereMock.mockResolvedValueOnce([]);

    await endStaleRuntimes("session-123");

    expect(destroyByIdMock).not.toHaveBeenCalled();
    expect(updateWhereMock).not.toHaveBeenCalled();
  });

  it("still marks DB records as failed even if destroyById throws", async () => {
    selectWhereMock.mockResolvedValueOnce([
      { id: "rt-1", sandboxId: "sbx-dead" },
    ]);
    destroyByIdMock.mockRejectedValueOnce(new Error("sandbox not found"));

    await endStaleRuntimes("session-123");

    // Promise.allSettled means the error is caught, DB update still runs
    expect(destroyByIdMock).toHaveBeenCalledWith("sbx-dead");
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
  });
});
