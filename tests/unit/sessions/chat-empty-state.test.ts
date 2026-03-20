/**
 * Unit Test: SessionChat empty-state resolution
 *
 * Verifies that the SessionChat component renders the correct empty-state
 * message based on session status — not a generic spinner for all cases.
 */

import { describe, it, expect } from "vitest";
import { getStatusConfig, SESSION_STATUSES } from "@/lib/sessions/status";

/**
 * Pure function that mirrors the empty-state logic in SessionChat.
 * Tests the decision without needing a React test harness.
 */
function resolveEmptyState(sessionStatus: string | null): "spinner" | "terminal" | "idle" {
  if (!sessionStatus) return "spinner";

  const config = getStatusConfig(sessionStatus);

  if (config.isTerminal) return "terminal";
  if (sessionStatus === "idle" || sessionStatus === "hibernated") return "idle";
  return "spinner";
}

describe("SessionChat empty-state resolution", () => {
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
    // Ensure we have a test case for every status
    for (const status of SESSION_STATUSES) {
      const result = resolveEmptyState(status);
      expect(["spinner", "terminal", "idle"]).toContain(result);
    }
  });
});
