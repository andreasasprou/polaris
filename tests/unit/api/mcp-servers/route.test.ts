import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionWithOrgAdminMock } = vi.hoisted(() => ({
  getSessionWithOrgAdminMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionWithOrgAdmin: getSessionWithOrgAdminMock,
  getSessionWithOrg: vi.fn(),
}));

vi.mock("@/lib/mcp-servers/queries", () => ({
  findMcpServersByOrg: vi.fn(),
}));

vi.mock("@/lib/mcp-servers/actions", () => ({
  createMcpServer: vi.fn(),
}));

vi.mock("@/lib/mcp-servers/catalog", () => ({
  getCatalogTemplate: vi.fn(),
  resolveCatalogServerUrl: vi.fn(),
}));

vi.mock("@/lib/evlog", () => ({
  withEvlog: <Args extends unknown[], Result>(
    handler: (...args: Args) => Result,
  ) => handler,
}));

const { POST } = await import("@/app/api/mcp-servers/route");

describe("POST /api/mcp-servers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionWithOrgAdminMock.mockResolvedValue({
      orgId: "org-1",
      session: { user: { id: "user-1" } },
    });
  });

  it("rejects malformed JSON bodies", async () => {
    const response = await POST(
      new Request("https://polaris.example.com/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON body",
    });
  });

  it("rejects non-object JSON bodies", async () => {
    const response = await POST(
      new Request("https://polaris.example.com/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "JSON body must be an object",
    });
  });
});
