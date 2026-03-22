import { NextResponse } from "next/server";
import { getSessionWithOrg, getSessionWithOrgAdmin } from "@/lib/auth/session";
import { findMcpServersByOrg } from "@/lib/mcp-servers/queries";
import { createMcpServer } from "@/lib/mcp-servers/actions";
import { isValidUrl, validateServerFetchUrl } from "@/lib/mcp-servers/url-validation";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async () => {
  const { orgId } = await getSessionWithOrg();
  const servers = await findMcpServersByOrg(orgId);
  return NextResponse.json({ servers });
});

const VALID_TRANSPORTS = ["streamable-http", "sse"] as const;
const VALID_AUTH_TYPES = ["static", "oauth"] as const;

export const POST = withEvlog(async (req: Request) => {
  const admin = await getSessionWithOrgAdmin();
  if (!admin) return NextResponse.json({ error: "Only organization owners and admins can manage MCP servers" }, { status: 403 });
  const { session, orgId } = admin;
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
        { error: "oauthAuthorizationEndpoint must be a valid HTTPS URL (private/internal hosts blocked)" },
        { status: 400 },
      );
    }
    // Token endpoint is server-fetched — validate with DNS resolution to block
    // domains that resolve to private IPs (prevents SSRF via DNS rebinding)
    if (!tokenEndpoint || !(await validateServerFetchUrl(tokenEndpoint))) {
      return NextResponse.json(
        { error: "oauthTokenEndpoint must be a valid HTTPS URL that does not resolve to a private/internal address" },
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
