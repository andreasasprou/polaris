/**
 * Unit Test: SessionChat empty-state resolution
 *
 * Tests the exported resolveEmptyState function from session-chat.tsx
 * to verify correct empty-state rendering for all session statuses.
 */

import { describe, it, expect } from "vitest";
import { resolveEmptyState } from "@/components/sessions/session-chat";
import { SESSION_STATUSES } from "@/lib/sessions/status";

describe("resolveEmptyState", () => {
  it("shows spinner for active status", () => {
    expect(resolveEmptyState("active")).toBe("spinner");
  });

  it("shows spinner for creating status", () => {
    expect(resolveEmptyState("creating")).toBe("spinner");
  });

  it("shows spinner for snapshotting status", () => {
    expect(resolveEmptyState("snapshotting")).toBe("spinner");
  });

  it("shows spinner when sessionStatus is null", () => {
    expect(resolveEmptyState(null)).toBe("spinner");
  });

  it("shows spinner when sessionStatus is undefined", () => {
    expect(resolveEmptyState(undefined)).toBe("spinner");
  });

  it("shows terminal message for completed status", () => {
    expect(resolveEmptyState("completed")).toBe("terminal");
  });

  it("shows terminal message for failed status", () => {
    expect(resolveEmptyState("failed")).toBe("terminal");
  });

  it("shows terminal message for stopped status", () => {
    expect(resolveEmptyState("stopped")).toBe("terminal");
  });

  it("shows idle message for idle status", () => {
    expect(resolveEmptyState("idle")).toBe("idle");
  });

  it("shows idle message for hibernated status", () => {
    expect(resolveEmptyState("hibernated")).toBe("idle");
  });

  it("covers all session statuses", () => {
    for (const status of SESSION_STATUSES) {
      const result = resolveEmptyState(status);
      expect(["spinner", "terminal", "idle"]).toContain(result);
    }
  });
});
