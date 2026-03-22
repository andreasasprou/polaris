import dns from "node:dns/promises";

/** Check if an IP address is private/internal. */
function isPrivateIp(ip: string): boolean {
  // IPv4
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
    if (parts[0] === 10) return true; // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local
    if (parts[0] === 127) return true; // loopback
    if (parts[0] === 0) return true; // 0.0.0.0
  }

  // IPv6
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fe80:")) return true; // link-local
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // ULA

  return false;
}

/** Check if a hostname looks like a private/internal target (string-level). */
export function isPrivateHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  ) return true;

  // Check if hostname is a raw IP
  if (isPrivateIp(hostname)) return true;

  // Common internal DNS patterns
  if (
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".corp") ||
    hostname.endsWith(".lan")
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
    // Resolve DNS and check all IPs
    const addresses = await dns.resolve4(url.hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(url.hostname).catch(() => [] as string[]);
    const allAddresses = [...addresses, ...addresses6];

    // If we can't resolve at all, block (fail-closed for server fetches)
    if (allAddresses.length === 0) return null;

    for (const ip of allAddresses) {
      if (isPrivateIp(ip)) return null;
    }

    return urlStr;
  } catch {
    return null;
  }
}

/**
 * SSRF-safe fetch for server-side OAuth requests.
 *
 * 1. Re-validates the URL via DNS resolution immediately before the request
 *    (prevents DNS rebinding between creation and use).
 * 2. Uses `redirect: "manual"` so 307/308 redirects are caught and their
 *    Location headers are validated before following.
 * 3. Follows up to 3 redirects, re-validating each hop.
 */
export async function safeFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const MAX_REDIRECTS = 3;
  let currentUrl = url;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // Re-validate DNS on every hop
    const validated = await validateServerFetchUrl(currentUrl);
    if (!validated) {
      throw new Error(`SSRF blocked: ${currentUrl} resolves to a private/internal address`);
    }

    const res = await fetch(currentUrl, {
      ...init,
      redirect: "manual",
    });

    // Not a redirect — return the response
    if (res.status < 300 || res.status >= 400) {
      return res;
    }

    // Handle redirect
    const location = res.headers.get("location");
    if (!location) {
      throw new Error(`Redirect ${res.status} without Location header`);
    }

    // Resolve relative redirects
    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}
