import { describe, it, expect } from "vitest";
import {
  JOB_STATUSES,
  JOB_TRANSITIONS,
  JOB_TERMINAL_STATUSES,
  JOB_ACTIVE_STATUSES,
  ATTEMPT_STATUSES,
  ATTEMPT_TRANSITIONS,
  ATTEMPT_TERMINAL_STATUSES,
  isJobTerminal,
  isAttemptTerminal,
  isValidJobTransition,
  isValidAttemptTransition,
  type JobStatus,
  type AttemptStatus,
} from "@/lib/jobs/status";

describe("Job Status Model", () => {
  // ── JOB_TRANSITIONS covers every job status ──

  it("JOB_TRANSITIONS has an entry for every JOB_STATUSES value", () => {
    for (const status of JOB_STATUSES) {
      expect(JOB_TRANSITIONS[status]).toBeDefined();
    }
  });

  // ── Terminal statuses have empty transition arrays ──

  describe("terminal job statuses have no outgoing transitions", () => {
    it.each([...JOB_TERMINAL_STATUSES])("%s has empty transitions", (status) => {
      expect(JOB_TRANSITIONS[status as JobStatus]).toEqual([]);
    });
  });

  // ── Active and terminal sets are disjoint ──

  it("JOB_ACTIVE_STATUSES and JOB_TERMINAL_STATUSES are disjoint", () => {
    for (const status of JOB_ACTIVE_STATUSES) {
      expect(JOB_TERMINAL_STATUSES.has(status)).toBe(false);
    }
    for (const status of JOB_TERMINAL_STATUSES) {
      expect(JOB_ACTIVE_STATUSES.has(status)).toBe(false);
    }
  });

  it("JOB_ACTIVE_STATUSES + JOB_TERMINAL_STATUSES cover all JOB_STATUSES", () => {
    const combined = new Set([...JOB_ACTIVE_STATUSES, ...JOB_TERMINAL_STATUSES]);
    for (const status of JOB_STATUSES) {
      expect(combined.has(status)).toBe(true);
    }
  });

  // ── isValidJobTransition: valid transitions ──

  describe("isValidJobTransition — valid transitions", () => {
    const validCases: [JobStatus, JobStatus][] = [];
    for (const from of JOB_STATUSES) {
      for (const to of JOB_TRANSITIONS[from]) {
        validCases.push([from, to]);
      }
    }

    it.each(validCases)("%s -> %s is valid", (from, to) => {
      expect(isValidJobTransition(from, to)).toBe(true);
    });
  });

  // ── isValidJobTransition: invalid transitions ──

  describe("isValidJobTransition — invalid transitions", () => {
    const invalidCases: [JobStatus, JobStatus][] = [];
    for (const from of JOB_STATUSES) {
      const allowed = new Set(JOB_TRANSITIONS[from]);
      for (const to of JOB_STATUSES) {
        if (!allowed.has(to)) {
          invalidCases.push([from, to]);
        }
      }
    }

    it.each(invalidCases)("%s -> %s is invalid", (from, to) => {
      expect(isValidJobTransition(from, to)).toBe(false);
    });
  });

  it("isValidJobTransition returns false for unknown from status", () => {
    expect(isValidJobTransition("nonexistent", "pending")).toBe(false);
  });

  // ── isJobTerminal ──

  describe("isJobTerminal", () => {
    it.each([...JOB_TERMINAL_STATUSES])("%s is terminal", (status) => {
      expect(isJobTerminal(status)).toBe(true);
    });

    it.each([...JOB_ACTIVE_STATUSES])("%s is not terminal", (status) => {
      expect(isJobTerminal(status)).toBe(false);
    });

    it("returns false for unknown status", () => {
      expect(isJobTerminal("nonexistent")).toBe(false);
    });
  });
});

describe("Attempt Status Model", () => {
  // ── ATTEMPT_TRANSITIONS covers every attempt status ──

  it("ATTEMPT_TRANSITIONS has an entry for every ATTEMPT_STATUSES value", () => {
    for (const status of ATTEMPT_STATUSES) {
      expect(ATTEMPT_TRANSITIONS[status]).toBeDefined();
    }
  });

  // ── Terminal attempt statuses have empty transition arrays ──

  describe("terminal attempt statuses have no outgoing transitions", () => {
    it.each([...ATTEMPT_TERMINAL_STATUSES])("%s has empty transitions", (status) => {
      expect(ATTEMPT_TRANSITIONS[status as AttemptStatus]).toEqual([]);
    });
  });

  // ── Active and terminal sets are disjoint ──

  it("ATTEMPT_TERMINAL_STATUSES does not overlap with active statuses", () => {
    const activeAttemptStatuses = ATTEMPT_STATUSES.filter(
      (s) => !ATTEMPT_TERMINAL_STATUSES.has(s),
    );
    for (const status of activeAttemptStatuses) {
      expect(ATTEMPT_TERMINAL_STATUSES.has(status)).toBe(false);
    }
  });

  // ── isValidAttemptTransition: valid transitions ──

  describe("isValidAttemptTransition — valid transitions", () => {
    const validCases: [AttemptStatus, AttemptStatus][] = [];
    for (const from of ATTEMPT_STATUSES) {
      for (const to of ATTEMPT_TRANSITIONS[from]) {
        validCases.push([from, to]);
      }
    }

    it.each(validCases)("%s -> %s is valid", (from, to) => {
      expect(isValidAttemptTransition(from, to)).toBe(true);
    });
  });

  // ── isValidAttemptTransition: invalid transitions ──

  describe("isValidAttemptTransition — invalid transitions", () => {
    const invalidCases: [AttemptStatus, AttemptStatus][] = [];
    for (const from of ATTEMPT_STATUSES) {
      const allowed = new Set(ATTEMPT_TRANSITIONS[from]);
      for (const to of ATTEMPT_STATUSES) {
        if (!allowed.has(to)) {
          invalidCases.push([from, to]);
        }
      }
    }

    it.each(invalidCases)("%s -> %s is invalid", (from, to) => {
      expect(isValidAttemptTransition(from, to)).toBe(false);
    });
  });

  it("isValidAttemptTransition returns false for unknown from status", () => {
    expect(isValidAttemptTransition("nonexistent", "accepted")).toBe(false);
  });

  // ── isAttemptTerminal ──

  describe("isAttemptTerminal", () => {
    it.each([...ATTEMPT_TERMINAL_STATUSES])("%s is terminal", (status) => {
      expect(isAttemptTerminal(status)).toBe(true);
    });

    const activeAttemptStatuses = ATTEMPT_STATUSES.filter(
      (s) => !ATTEMPT_TERMINAL_STATUSES.has(s),
    );

    it.each(activeAttemptStatuses)("%s is not terminal", (status) => {
      expect(isAttemptTerminal(status)).toBe(false);
    });

    it("returns false for unknown status", () => {
      expect(isAttemptTerminal("nonexistent")).toBe(false);
    });
  });
});
