import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSessionWithOrgMock,
  getOrgSlugByIdMock,
  updateMcpServerAuthMock,
  verifyMcpOAuthStateMock,
  findMcpServerByIdAndOrgMock,
  dbSelectMock,
} = vi.hoisted(() => ({
  getSessionWithOrgMock: vi.fn(),
  getOrgSlugByIdMock: vi.fn(),
  updateMcpServerAuthMock: vi.fn(),
  verifyMcpOAuthStateMock: vi.fn(),
  findMcpServerByIdAndOrgMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionWithOrg: getSessionWithOrgMock,
  getOrgSlugById: getOrgSlugByIdMock,
}));

vi.mock("@/lib/mcp-servers/actions", () => ({
  updateMcpServerAuth: updateMcpServerAuthMock,
}));

vi.mock("@/lib/mcp-servers/oauth-state", () => ({
  verifyMcpOAuthState: verifyMcpOAuthStateMock,
}));

vi.mock("@/lib/mcp-servers/queries", () => ({
  findMcpServerByIdAndOrg: findMcpServerByIdAndOrgMock,
}));

vi.mock("@/lib/mcp-servers/url-validation", () => ({
  safeFetch: vi.fn(),
}));

vi.mock("@/lib/config/urls", () => ({
  getAppBaseUrl: () => "https://polaris.example.com",
  orgPath: (orgSlug: string, path: string) => `/${orgSlug}${path}`,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: dbSelectMock,
  },
}));

vi.mock("@/lib/db/auth-schema", () => ({
  member: {
    role: "role",
    userId: "user_id",
    organizationId: "organization_id",
  },
}));

vi.mock("@/lib/evlog", () => ({
  withEvlog: <Args extends unknown[], Result>(
    handler: (...args: Args) => Result,
  ) => handler,
}));

const { GET } = await import("@/app/api/mcp-servers/oauth/callback/route");

describe("GET /api/mcp-servers/oauth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionWithOrgMock.mockResolvedValue({
      orgId: "org-1",
      session: { user: { id: "user-1" } },
    });
    getOrgSlugByIdMock.mockResolvedValue("acme");
    dbSelectMock.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ role: "owner" }]),
        }),
      }),
    });
  });

  it("redirects provider errors back to the originating catalog page when state is trusted", async () => {
    verifyMcpOAuthStateMock.mockReturnValue({
      orgId: "org-1",
      userId: "user-1",
      serverId: "server-1",
      nonce: "nonce-1",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    findMcpServerByIdAndOrgMock.mockResolvedValue({
      id: "server-1",
      catalogSlug: "sentry",
    });

    const response = await GET(
      new Request(
        "https://polaris.example.com/api/mcp-servers/oauth/callback?error=access_denied&state=signed-state",
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://polaris.example.com/acme/integrations/mcp/sentry?error=Access+was+denied+by+the+provider",
    );
    expect(updateMcpServerAuthMock).not.toHaveBeenCalled();
  });
});
