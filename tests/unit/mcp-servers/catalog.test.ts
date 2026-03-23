import { describe, expect, it } from "vitest";
import { getCatalogTemplateAvailability } from "@/lib/mcp-servers/catalog";

describe("getCatalogTemplateAvailability", () => {
  it("marks oauth-discovery templates unavailable without a configured client ID", () => {
    expect(
      getCatalogTemplateAvailability({
        slug: "sentry",
        name: "Sentry",
        description: "desc",
        icon: "/sentry.svg",
        category: "Monitoring",
        badge: "official",
        transport: "streamable-http",
        ownershipModel: "org-shared",
        permissionSummary: "Read issues",
        authType: "oauth-discovery",
        serverUrl: "https://mcp.sentry.dev/mcp",
        oauthClientId: "",
      }),
    ).toEqual({
      available: false,
      unavailableReason: "Sentry OAuth is not configured in this environment.",
    });
  });

  it("keeps static-header templates available", () => {
    expect(
      getCatalogTemplateAvailability({
        slug: "datadog",
        name: "Datadog",
        description: "desc",
        icon: "/datadog.svg",
        category: "Monitoring",
        badge: "official",
        transport: "streamable-http",
        ownershipModel: "org-shared",
        permissionSummary: "Read telemetry",
        authType: "static-headers",
        serverUrl: null,
        requiredHeaders: ["DD-API-KEY"],
      }),
    ).toEqual({
      available: true,
      unavailableReason: null,
    });
  });
});
