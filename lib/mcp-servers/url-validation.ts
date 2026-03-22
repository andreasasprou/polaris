import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/** Check if an IP address is private/internal. */
function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:x.x.x.x) — extract the IPv4 part and check it
  const v4MappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedMatch) return isPrivateIp(v4MappedMatch[1]);

  // IPv4
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
    if (parts[0] === 10) return true; // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local
    if (parts[0] === 127) return true; // loopback
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT 100.64.0.0/10
    if (parts[0] === 0) return true; // 0.0.0.0
  }

  // IPv6
  if (ip === "::1" || ip === "::") return true;
  // Link-local fe80::/10 (covers fe80:: through febf::)
  const lowerIp = ip.toLowerCase();
  if (lowerIp.startsWith("fe8") || lowerIp.startsWith("fe9") ||
      lowerIp.startsWith("fea") || lowerIp.startsWith("feb")) return true;
  // ULA fc00::/7
  if (lowerIp.startsWith("fc") || lowerIp.startsWith("fd")) return true;

  return false;
}

/** Check if a hostname looks like a private/internal target (string-level). */
export function isPrivateHostname(hostname: string): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  if (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1" ||
    normalizedHostname.endsWith(".localhost")
  ) return true;

  // Check if hostname is a raw IP
  if (isPrivateIp(normalizedHostname)) return true;

  // Common internal DNS patterns
  if (
    normalizedHostname.endsWith(".internal") ||
    normalizedHostname.endsWith(".local") ||
    normalizedHostname.endsWith(".corp") ||
    normalizedHostname.endsWith(".lan")
  ) return true;

  return false;
}

/**
 * Validate a URL for MCP server endpoints.
 * String-level check only (no DNS resolution).
 */
export function isValidUrl(urlStr: string, { allowLocalDev = false } = {}): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol === "http:") {
      return allowLocalDev && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    }
    if (url.protocol !== "https:") return false;
    if (isPrivateHostname(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a server-fetched URL by resolving DNS and checking resolved IPs.
 * Used for OAuth token endpoints that the control plane will POST to.
 * Returns the URL string if safe, or null if it resolves to a private address.
 */
export async function validateServerFetchUrl(urlStr: string): Promise<string | null> {
  // First pass: string-level check
  if (!isValidUrl(urlStr)) return null;

  try {
    const url = new URL(urlStr);
    await resolveToPublicIp(url.hostname);
    return urlStr;
  } catch {
    return null;
  }
}

/**
 * Validate OAuth endpoints before they are persisted or used.
 */
export async function validateOAuthEndpoints(
  authorizationEndpoint: string,
  tokenEndpoint: string,
): Promise<void> {
  if (!isValidUrl(authorizationEndpoint)) {
    throw new Error(
      "oauthAuthorizationEndpoint must be a valid HTTPS URL (private/internal hosts blocked)",
    );
  }

  if (!(await validateServerFetchUrl(tokenEndpoint))) {
    throw new Error(
      "oauthTokenEndpoint must be a valid HTTPS URL that does not resolve to a private/internal address",
    );
  }
}

type ResolvedPublicIp = {
  address: string;
  family: 4 | 6;
};

/**
 * Resolve a hostname to a validated public IP address.
 * Returns the first safe address, or throws if any address is private or
 * the hostname is unresolvable.
 */
async function resolveToPublicIp(hostname: string): Promise<ResolvedPublicIp> {
  const normalizedHostname = normalizeHostname(hostname);

  if (isPrivateIp(normalizedHostname)) {
    throw new Error(`SSRF blocked: ${normalizedHostname} is a private address`);
  }

  const literalFamily = net.isIP(normalizedHostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return {
      address: normalizedHostname,
      family: literalFamily,
    };
  }

  const ipv4Addresses = await dns.resolve4(normalizedHostname).catch(
    () => [] as string[],
  );
  const ipv6Addresses = await dns.resolve6(normalizedHostname).catch(
    () => [] as string[],
  );
  const allAddresses: ResolvedPublicIp[] = [
    ...ipv4Addresses.map((address) => ({ address, family: 4 as const })),
    ...ipv6Addresses.map((address) => ({ address, family: 6 as const })),
  ];

  if (allAddresses.length === 0) {
    throw new Error(
      `SSRF blocked: ${normalizedHostname} resolves only to private/unresolvable addresses`,
    );
  }

  if (allAddresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error(
      `SSRF blocked: ${normalizedHostname} resolves to a private address`,
    );
  }

  return allAddresses[0];
}

/**
 * SSRF-safe fetch for server-side OAuth requests.
 *
 * Eliminates DNS rebinding TOCTOU by:
 * 1. Resolving DNS once and validating the IP is public.
 * 2. Connecting to the resolved IP directly via node:https with a custom
 *    `servername` for TLS SNI — so the certificate validates against the
 *    original hostname, not the IP.
 * 3. Using redirect: manual and re-validating each redirect hop.
 *
 * Uses node:https directly (not global fetch) because fetch doesn't support
 * connecting to a specific IP while overriding TLS servername.
 */
export async function safeFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const MAX_REDIRECTS = 3;
  let currentUrl = url;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!isValidUrl(currentUrl)) {
      throw new Error(`SSRF blocked: ${currentUrl} failed URL validation`);
    }

    const parsed = new URL(currentUrl);
    const originalHostname = parsed.hostname;
    const resolvedIp = await resolveToPublicIp(originalHostname);
    const port = parsed.port ? parseInt(parsed.port) : 443;

    const res = await httpsRequestWithPinnedIp({
      ip: resolvedIp.address,
      family: resolvedIp.family,
      port,
      servername: originalHostname,
      method: (init.method ?? "GET") as string,
      path: parsed.pathname + parsed.search,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        Host: parsed.port ? `${originalHostname}:${parsed.port}` : originalHostname,
      },
      body: init.body ? await bodyToString(init.body) : undefined,
      signal: init.signal as AbortSignal | undefined,
    });

    // Not a redirect — return as Response
    if (res.statusCode < 300 || res.statusCode >= 400) {
      return new Response(res.body, {
        status: res.statusCode,
        headers: res.headers,
      });
    }

    // Handle redirect
    const location = res.headers["location"];
    if (!location) {
      throw new Error(`Redirect ${res.statusCode} without Location header`);
    }
    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

export async function safeStreamingFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const MAX_REDIRECTS = 3;
  let currentUrl = url;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!isValidUrl(currentUrl)) {
      throw new Error(`SSRF blocked: ${currentUrl} failed URL validation`);
    }

    const parsed = new URL(currentUrl);
    const originalHostname = parsed.hostname;
    const resolvedIp = await resolveToPublicIp(originalHostname);
    const port = parsed.port ? parseInt(parsed.port) : 443;

    const res = await httpsRequestWithPinnedIpStream({
      ip: resolvedIp.address,
      family: resolvedIp.family,
      port,
      servername: originalHostname,
      method: (init.method ?? "GET") as string,
      path: parsed.pathname + parsed.search,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        Host: parsed.port ? `${originalHostname}:${parsed.port}` : originalHostname,
      },
      body: init.body ? await bodyToString(init.body) : undefined,
      signal: init.signal as AbortSignal | undefined,
    });

    if (res.statusCode < 300 || res.statusCode >= 400) {
      return new Response(Readable.toWeb(res.stream) as ReadableStream, {
        status: res.statusCode,
        headers: res.headers,
      });
    }

    const location = res.headers["location"];
    res.stream.destroy();
    if (!location) {
      throw new Error(`Redirect ${res.statusCode} without Location header`);
    }
    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

/** Convert RequestInit body to string for node:https. */
async function bodyToString(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (!body) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString();
  return String(body);
}

/** Low-level HTTPS request that connects to a specific IP with TLS SNI override. */
function httpsRequestWithPinnedIp(opts: {
  ip: string;
  family: 4 | 6;
  port: number;
  servername: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    const req = https.request(
      {
        hostname: opts.ip,
        family: opts.family,
        port: opts.port,
        path: opts.path,
        method: opts.method,
        headers: opts.headers,
        servername: opts.servername, // TLS SNI — cert validates against this
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers[key] = value;
            else if (Array.isArray(value)) headers[key] = value[0];
          }
          resolve({ statusCode: res.statusCode ?? 500, headers, body });
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);

    if (opts.signal) {
      const onAbort = () => {
        req.destroy(new DOMException("The operation was aborted.", "AbortError"));
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => opts.signal!.removeEventListener("abort", onAbort));
    }

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function httpsRequestWithPinnedIpStream(opts: {
  ip: string;
  family: 4 | 6;
  port: number;
  servername: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}): Promise<{ statusCode: number; headers: Record<string, string>; stream: import("node:http").IncomingMessage }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    const req = https.request(
      {
        hostname: opts.ip,
        family: opts.family,
        port: opts.port,
        path: opts.path,
        method: opts.method,
        headers: opts.headers,
        servername: opts.servername,
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === "string") headers[key] = value;
          else if (Array.isArray(value)) headers[key] = value[0];
        }
        resolve({
          statusCode: res.statusCode ?? 500,
          headers,
          stream: res,
        });
      },
    );

    req.on("error", reject);

    if (opts.signal) {
      const onAbort = () => {
        req.destroy(new DOMException("The operation was aborted.", "AbortError"));
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => opts.signal!.removeEventListener("abort", onAbort));
    }

    if (opts.body) req.write(opts.body);
    req.end();
  });
}
