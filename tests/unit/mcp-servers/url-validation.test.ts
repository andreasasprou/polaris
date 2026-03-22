import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolve4Mock, resolve6Mock, httpsRequestMock } = vi.hoisted(() => ({
  resolve4Mock: vi.fn(),
  resolve6Mock: vi.fn(),
  httpsRequestMock: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  default: {
    resolve4: resolve4Mock,
    resolve6: resolve6Mock,
  },
}));

vi.mock("node:https", () => ({
  default: {
    request: httpsRequestMock,
  },
}));

const {
  isPrivateHostname,
  safeFetch,
  validateOAuthEndpoints,
  validateServerFetchUrl,
} = await import("@/lib/mcp-servers/url-validation");

function mockHttpsResponse({
  statusCode = 200,
  headers = {},
  body = "",
}: {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
}) {
  httpsRequestMock.mockImplementation((options, callback) => {
    const req = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };

    req.write = vi.fn();
    req.end = vi.fn(() => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
      };

      res.statusCode = statusCode;
      res.headers = headers;
      callback(res);

      if (body) {
        res.emit("data", Buffer.from(body));
      }
      res.emit("end");
    });
    req.destroy = vi.fn((error?: Error) => {
      if (error) {
        req.emit("error", error);
      }
    });

    return req;
  });
}

describe("mcp URL validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolve4Mock.mockResolvedValue([]);
    resolve6Mock.mockResolvedValue([]);
  });

  it("treats bracketed IPv6 loopback hostnames as private", () => {
    expect(isPrivateHostname("[::1]")).toBe(true);
  });

  it("accepts public IPv6 hosts for server-side endpoint validation", async () => {
    resolve6Mock.mockResolvedValue(["2606:4700:4700::1111"]);

    await expect(
      validateServerFetchUrl("https://oauth.example.com/token"),
    ).resolves.toBe("https://oauth.example.com/token");
  });

  it("uses the pinned IPv6 address at runtime fetch time", async () => {
    resolve6Mock.mockResolvedValue(["2606:4700:4700::1111"]);
    mockHttpsResponse({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });

    const response = await safeFetch("https://oauth.example.com/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code" }),
    });

    expect(response.status).toBe(200);
    expect(httpsRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "2606:4700:4700::1111",
        family: 6,
        servername: "oauth.example.com",
      }),
      expect.any(Function),
    );
  });

  it("rejects OAuth token endpoints that resolve to private IPv6 addresses", async () => {
    resolve6Mock.mockResolvedValue(["fd00::1234"]);

    await expect(
      validateOAuthEndpoints(
        "https://oauth.example.com/authorize",
        "https://oauth.example.com/token",
      ),
    ).rejects.toThrow(
      "oauthTokenEndpoint must be a valid HTTPS URL that does not resolve to a private/internal address",
    );
  });
});
