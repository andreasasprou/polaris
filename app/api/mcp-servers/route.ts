import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findMcpServersByOrg } from "@/lib/mcp-servers/queries";
import { createMcpServer } from "@/lib/mcp-servers/actions";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async () => {
  const { orgId } = await getSessionWithOrg();
  const servers = await findMcpServersByOrg(orgId);
  return NextResponse.json({ servers });
});

function isValidUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    // Allow HTTP only for localhost/127.0.0.1 (local dev)
    if (url.protocol === "http:") {
      return (
        url.hostname === "localhost" || url.hostname === "127.0.0.1"
      );
    }
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

const VALID_TRANSPORTS = ["streamable-http", "sse"] as const;
const VALID_AUTH_TYPES = ["static", "oauth"] as const;

export const POST = withEvlog(async (req: Request) => {
  const { session, orgId } = await getSessionWithOrg();
  const body = await req.json();

  // Validate required fields
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const serverUrl = body.serverUrl?.trim();
  if (!serverUrl || !isValidUrl(serverUrl)) {
    return NextResponse.json(
      { error: "serverUrl must be a valid HTTPS URL (HTTP allowed for localhost)" },
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
