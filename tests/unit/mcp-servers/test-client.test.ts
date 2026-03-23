import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  isValidUrlMock,
  validateServerFetchUrlMock,
  safeFetchMock,
  safeStreamingFetchMock,
} = vi.hoisted(() => ({
  isValidUrlMock: vi.fn(),
  validateServerFetchUrlMock: vi.fn(),
  safeFetchMock: vi.fn(),
  safeStreamingFetchMock: vi.fn(),
}));

vi.mock("@/lib/mcp-servers/url-validation", () => ({
  isValidUrl: isValidUrlMock,
  validateServerFetchUrl: validateServerFetchUrlMock,
  safeFetch: safeFetchMock,
  safeStreamingFetch: safeStreamingFetchMock,
}));

const { testMcpServerConnection } = await import("@/lib/mcp-servers/test-client");

describe("mcp test client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isValidUrlMock.mockImplementation((url: string, options?: { allowLocalDev?: boolean }) => {
      if (url.startsWith("http://127.0.0.1:")) {
        return options?.allowLocalDev === true;
      }
      return true;
    });
    validateServerFetchUrlMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://")) {
        return url;
      }
      return null;
    });
  });

  it("rejects legacy SSE endpoint pivots to localhost from external servers", async () => {
    safeStreamingFetchMock.mockResolvedValue(
      new Response("event: endpoint\ndata: http://127.0.0.1:4318/messages\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    await expect(
      testMcpServerConnection({
        serverUrl: "https://mcp.example.com/sse",
        transport: "sse",
      }),
    ).rejects.toThrow("Invalid MCP server URL: http://127.0.0.1:4318/messages");

    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});
