import { describe, it, expect } from "vitest";
import {
  SESSION_STATUSES,
  STATUS_CONFIG,
  getStatusConfig,
  type SessionStatus,
} from "@/lib/sessions/status";

describe("Session Status Model", () => {
  // ── Coverage: every SESSION_STATUSES entry has a STATUS_CONFIG entry ──

  it("STATUS_CONFIG has an entry for every SESSION_STATUSES value", () => {
    for (const status of SESSION_STATUSES) {
      expect(STATUS_CONFIG[status]).toBeDefined();
    }
  });

  it("STATUS_CONFIG has no extra keys beyond SESSION_STATUSES", () => {
    const statusSet = new Set<string>(SESSION_STATUSES);
    for (const key of Object.keys(STATUS_CONFIG)) {
      expect(statusSet.has(key)).toBe(true);
    }
  });

  // ── Terminal states ──

  const terminalStatuses: SessionStatus[] = ["stopped", "completed", "failed"];
  const activeStatuses: SessionStatus[] = ["creating", "active", "snapshotting"];
  const stableNonTerminal: SessionStatus[] = ["idle", "hibernated"];

  describe.each(terminalStatuses)("terminal status: %s", (status) => {
    it("isTerminal = true", () => {
      expect(STATUS_CONFIG[status].isTerminal).toBe(true);
    });

    it("pollIntervalMs = 0", () => {
      expect(STATUS_CONFIG[status].pollIntervalMs).toBe(0);
    });

    it("canStop = false", () => {
      expect(STATUS_CONFIG[status].canStop).toBe(false);
    });
  });

  // ── Active (transient) states ──

  describe.each(activeStatuses)("active status: %s", (status) => {
    it("isTerminal = false", () => {
      expect(STATUS_CONFIG[status].isTerminal).toBe(false);
    });

    it("pollIntervalMs = 2000", () => {
      expect(STATUS_CONFIG[status].pollIntervalMs).toBe(2_000);
    });
  });

  // ── Stable non-terminal states ──

  describe.each(stableNonTerminal)("stable non-terminal status: %s", (status) => {
    it("isTerminal = false", () => {
      expect(STATUS_CONFIG[status].isTerminal).toBe(false);
    });

    it("pollIntervalMs = 0", () => {
      expect(STATUS_CONFIG[status].pollIntervalMs).toBe(0);
    });
  });

  // ── canSend matrix ──

  const canSendExpected: Record<SessionStatus, boolean> = {
    creating: false,
    active: false,
    idle: true,
    snapshotting: false,
    hibernated: true,
    stopped: true,
    completed: true,
    failed: true,
  };

  describe("canSend", () => {
    it.each(Object.entries(canSendExpected))(
      "%s => canSend = %s",
      (status, expected) => {
        expect(STATUS_CONFIG[status as SessionStatus].canSend).toBe(expected);
      },
    );
  });

  // ── canStop matrix ──

  const canStopExpected: Record<SessionStatus, boolean> = {
    creating: false,
    active: true,
    idle: false,
    snapshotting: false,
    hibernated: false,
    stopped: false,
    completed: false,
    failed: false,
  };

  describe("canStop", () => {
    it.each(Object.entries(canStopExpected))(
      "%s => canStop = %s",
      (status, expected) => {
        expect(STATUS_CONFIG[status as SessionStatus].canStop).toBe(expected);
      },
    );
  });

  // ── getStatusConfig ──

  describe("getStatusConfig", () => {
    it("returns correct config for known statuses", () => {
      for (const status of SESSION_STATUSES) {
        expect(getStatusConfig(status)).toBe(STATUS_CONFIG[status]);
      }
    });

    it("falls back to failed config for unknown status", () => {
      expect(getStatusConfig("nonexistent")).toEqual(STATUS_CONFIG.failed);
    });

    it("falls back to failed config for empty string", () => {
      expect(getStatusConfig("")).toEqual(STATUS_CONFIG.failed);
    });
  });
});
