import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionWithOrgAdminMock, discoverOAuthConfigMock } = vi.hoisted(
  () => ({
    getSessionWithOrgAdminMock: vi.fn(),
    discoverOAuthConfigMock: vi.fn(),
  }),
);

vi.mock("@/lib/auth/session", () => ({
  getSessionWithOrgAdmin: getSessionWithOrgAdminMock,
}));

vi.mock("@/lib/mcp-servers/discovery", () => ({
  discoverOAuthConfig: discoverOAuthConfigMock,
}));

vi.mock("@/lib/evlog", () => ({
  withEvlog: <Args extends unknown[], Result>(
    handler: (...args: Args) => Result,
  ) => handler,
}));

const { POST } = await import("@/app/api/mcp-servers/discover/route");

describe("POST /api/mcp-servers/discover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionWithOrgAdminMock.mockResolvedValue({
      orgId: "org-1",
      session: { user: { id: "user-1" } },
    });
  });

  it("rejects malformed JSON bodies", async () => {
    const response = await POST(
      new Request("https://polaris.example.com/api/mcp-servers/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON body",
    });
    expect(discoverOAuthConfigMock).not.toHaveBeenCalled();
  });
});
