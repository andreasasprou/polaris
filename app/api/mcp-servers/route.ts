import { NextResponse } from "next/server";
import { getSessionWithOrg, requireOrgAdmin } from "@/lib/auth/session";
import { findMcpServersByOrg } from "@/lib/mcp-servers/queries";
import { createMcpServer } from "@/lib/mcp-servers/actions";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async () => {
  const { orgId } = await getSessionWithOrg();
  const servers = await findMcpServersByOrg(orgId);
  return NextResponse.json({ servers });
});

/** Check if a hostname looks like a private/internal target. */
function isPrivateHostname(hostname: string): boolean {
  // Loopback
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  ) return true;

  // RFC1918 private ranges
  const parts = hostname.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
    if (parts[0] === 10) return true; // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local
    if (parts[0] === 0) return true; // 0.0.0.0
  }

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
 * - MCP server URLs: HTTPS required, HTTP allowed for localhost in dev only
 * - OAuth endpoints (server-fetched): HTTPS required, private/internal hosts blocked
 */
function isValidUrl(urlStr: string, { allowLocalDev = false } = {}): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol === "http:") {
      return allowLocalDev && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    }
    if (url.protocol !== "https:") return false;
    // Block private/internal targets for HTTPS too
    if (isPrivateHostname(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

const VALID_TRANSPORTS = ["streamable-http", "sse"] as const;
const VALID_AUTH_TYPES = ["static", "oauth"] as const;

export const POST = withEvlog(async (req: Request) => {
  const { session, orgId } = await requireOrgAdmin();
  const body = await req.json();

  // Validate required fields
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const serverUrl = body.serverUrl?.trim();
  if (!serverUrl || !isValidUrl(serverUrl, { allowLocalDev: true })) {
    return NextResponse.json(
      { error: "serverUrl must be a valid HTTPS URL (HTTP allowed for localhost). Private/internal hosts are blocked." },
      { status: 400 },
    );
  }

  const transport = body.transport ?? "streamable-http";
  if (!VALID_TRANSPORTS.includes(transport)) {
    return NextResponse.json(
      { error: `transport must be one of: ${VALID_TRANSPORTS.join(", ")}` },
      { status: 400 },
    );
  }

  const authType = body.authType;
  if (!VALID_AUTH_TYPES.includes(authType)) {
    return NextResponse.json(
      { error: `authType must be one of: ${VALID_AUTH_TYPES.join(", ")}` },
      { status: 400 },
    );
  }

  // Static: headers required
  if (authType === "static") {
    if (
      !body.headers ||
      typeof body.headers !== "object" ||
      Object.keys(body.headers).length === 0
    ) {
      return NextResponse.json(
        { error: "headers are required for static auth (at least one header)" },
        { status: 400 },
      );
    }
  }

  // OAuth: metadata required
  if (authType === "oauth") {
    if (!body.oauthClientId?.trim()) {
      return NextResponse.json(
        { error: "oauthClientId is required for OAuth servers" },
        { status: 400 },
      );
    }
    const authEndpoint = body.oauthAuthorizationEndpoint?.trim();
    const tokenEndpoint = body.oauthTokenEndpoint?.trim();
    if (!authEndpoint || !isValidUrl(authEndpoint)) {
      return NextResponse.json(
        { error: "oauthAuthorizationEndpoint must be a valid HTTPS URL" },
        { status: 400 },
      );
    }
    if (!tokenEndpoint || !isValidUrl(tokenEndpoint)) {
      return NextResponse.json(
        { error: "oauthTokenEndpoint must be a valid HTTPS URL" },
        { status: 400 },
      );
    }
  }

  try {
    const server = await createMcpServer({
      organizationId: orgId,
      name,
      serverUrl,
      transport,
      authType,
      authConfig:
        authType === "static" ? { headers: body.headers } : undefined,
      oauthClientId: body.oauthClientId?.trim() ?? null,
      oauthAuthorizationEndpoint:
        body.oauthAuthorizationEndpoint?.trim() ?? null,
      oauthTokenEndpoint: body.oauthTokenEndpoint?.trim() ?? null,
      oauthScopes: body.oauthScopes?.trim() ?? null,
      createdBy: session.user.id,
    });

    return NextResponse.json({ server }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message.includes("unique")) {
      return NextResponse.json(
        { error: `An MCP server named "${name}" already exists` },
        { status: 409 },
      );
    }
    throw err;
  }
});
