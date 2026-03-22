import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
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
  safeStreamingFetch,
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
    httpsRequestMock.mockReset();
    resolve4Mock.mockReset();
    resolve6Mock.mockReset();
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

  it("drops auth headers on cross-origin redirects in safeFetch", async () => {
    resolve4Mock.mockResolvedValue(["203.0.113.10"]);
    httpsRequestMock
      .mockImplementationOnce((options, callback) => {
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

          res.statusCode = 302;
          res.headers = { location: "https://redirect.example.com/token" };
          callback(res);
          res.emit("end");
        });
        req.destroy = vi.fn();

        return req;
      })
      .mockImplementationOnce((options, callback) => {
        expect(options.headers).not.toHaveProperty("authorization");
        expect(options.headers).not.toHaveProperty("x-api-key");
        expect(options.headers).toMatchObject({
          accept: "application/json",
          "content-type": "application/json",
          Host: "redirect.example.com",
        });

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

          res.statusCode = 200;
          res.headers = { "content-type": "application/json" };
          callback(res);
          res.emit("data", Buffer.from('{"ok":true}'));
          res.emit("end");
        });
        req.destroy = vi.fn();

        return req;
      });

    await expect(
      safeFetch("https://oauth.example.com/token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
          "X-Api-Key": "secret-api-key",
        },
        body: JSON.stringify({ hello: "world" }),
      }),
    ).rejects.toThrow("Cross-origin redirect blocked for request with body");
  });

  it("drops auth headers on cross-origin redirects in safeStreamingFetch", async () => {
    resolve4Mock.mockResolvedValue(["203.0.113.10"]);
    httpsRequestMock
      .mockImplementationOnce((options, callback) => {
        const req = new EventEmitter() as EventEmitter & {
          write: ReturnType<typeof vi.fn>;
          end: ReturnType<typeof vi.fn>;
          destroy: ReturnType<typeof vi.fn>;
        };

        req.write = vi.fn();
        req.end = vi.fn(() => {
          const res = Readable.from([]) as Readable & {
            statusCode: number;
            headers: Record<string, string>;
          };

          res.statusCode = 307;
          res.headers = { location: "https://stream.example.com/sse" };
          callback(res);
        });
        req.destroy = vi.fn();

        return req;
      })
      .mockImplementationOnce((options, callback) => {
        expect(options.headers).not.toHaveProperty("authorization");
        expect(options.headers).not.toHaveProperty("x-api-key");
        expect(options.headers).toMatchObject({
          accept: "text/event-stream",
          Host: "stream.example.com",
        });

        const req = new EventEmitter() as EventEmitter & {
          write: ReturnType<typeof vi.fn>;
          end: ReturnType<typeof vi.fn>;
          destroy: ReturnType<typeof vi.fn>;
        };

        req.write = vi.fn();
        req.end = vi.fn(() => {
          const res = Readable.from(["data: ready\n\n"]) as Readable & {
            statusCode: number;
            headers: Record<string, string>;
          };

          res.statusCode = 200;
          res.headers = { "content-type": "text/event-stream" };
          callback(res);
        });
        req.destroy = vi.fn();

        return req;
      });

    const response = await safeStreamingFetch("https://oauth.example.com/sse", {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: "Bearer secret-token",
        "X-Api-Key": "secret-api-key",
      },
    });

    expect(response.status).toBe(200);
  });

  it("allows same-origin redirects to preserve POST bodies", async () => {
    resolve4Mock.mockResolvedValue(["203.0.113.10"]);
    httpsRequestMock
      .mockImplementationOnce((options, callback) => {
        expect(options.headers).toMatchObject({
          Host: "oauth.example.com",
        });

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

          res.statusCode = 307;
          res.headers = { location: "https://oauth.example.com/token-2" };
          callback(res);
          res.emit("end");
        });
        req.destroy = vi.fn();

        return req;
      })
      .mockImplementationOnce((options, callback) => {
        expect(options.headers).toMatchObject({
          Host: "oauth.example.com",
        });

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

          res.statusCode = 200;
          res.headers = { "content-type": "application/json" };
          callback(res);
          res.emit("data", Buffer.from('{"ok":true}'));
          res.emit("end");
        });
        req.destroy = vi.fn();

        return req;
      });

    const response = await safeFetch("https://oauth.example.com/token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer secret-token",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
  });
});
