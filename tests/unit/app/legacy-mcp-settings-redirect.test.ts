import { beforeEach, describe, expect, it, vi } from "vitest";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

const { default: LegacyMcpSettingsRedirect } = await import(
  "@/app/(dashboard)/[orgSlug]/settings/mcp/page"
);

describe("LegacyMcpSettingsRedirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves success and error query parameters", async () => {
    await LegacyMcpSettingsRedirect({
      params: Promise.resolve({ orgSlug: "acme" }),
      searchParams: Promise.resolve({
        success: "connected",
        error: "ignored",
      }),
    });

    expect(redirectMock).toHaveBeenCalledWith(
      "/acme/integrations/mcp/custom?success=connected&error=ignored",
    );
  });

  it("redirects without a query string when no banner params are present", async () => {
    await LegacyMcpSettingsRedirect({
      params: Promise.resolve({ orgSlug: "acme" }),
      searchParams: Promise.resolve({}),
    });

    expect(redirectMock).toHaveBeenCalledWith(
      "/acme/integrations/mcp/custom",
    );
  });
});
