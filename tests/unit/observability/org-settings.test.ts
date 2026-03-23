import { describe, expect, it } from "vitest";
import {
  isSandboxRawLogDebugEnabled,
  normalizeOrgObservabilitySettings,
} from "@/lib/observability/org-settings";

describe("org observability settings", () => {
  it("normalizes missing metadata to safe defaults", () => {
    expect(normalizeOrgObservabilitySettings(null)).toEqual({
      sandboxRawLogs: {
        enabled: false,
        expiresAt: null,
        reason: null,
        updatedAt: null,
        updatedBy: null,
      },
    });
  });

  it("parses sandbox raw log settings from organization metadata", () => {
    const settings = normalizeOrgObservabilitySettings({
      observability: {
        sandboxRawLogs: {
          enabled: true,
          expiresAt: "2026-03-24T10:00:00.000Z",
          reason: "incident triage",
          updatedAt: "2026-03-23T10:00:00.000Z",
          updatedBy: "user_123",
        },
      },
    });

    expect(settings.sandboxRawLogs).toEqual({
      enabled: true,
      expiresAt: "2026-03-24T10:00:00.000Z",
      reason: "incident triage",
      updatedAt: "2026-03-23T10:00:00.000Z",
      updatedBy: "user_123",
    });
  });

  it("only treats debug mode as active before expiry", () => {
    const active = normalizeOrgObservabilitySettings({
      observability: {
        sandboxRawLogs: {
          enabled: true,
          expiresAt: "2026-03-24T10:00:00.000Z",
        },
      },
    });
    const expired = normalizeOrgObservabilitySettings({
      observability: {
        sandboxRawLogs: {
          enabled: true,
          expiresAt: "2026-03-22T10:00:00.000Z",
        },
      },
    });

    expect(
      isSandboxRawLogDebugEnabled(active, new Date("2026-03-23T10:00:00.000Z")),
    ).toBe(true);
    expect(
      isSandboxRawLogDebugEnabled(expired, new Date("2026-03-23T10:00:00.000Z")),
    ).toBe(false);
  });
});
