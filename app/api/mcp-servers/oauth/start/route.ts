import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getSessionWithOrgAdmin } from "@/lib/auth/session";
import { findMcpServerByIdAndOrg } from "@/lib/mcp-servers/queries";
import { signMcpOAuthState } from "@/lib/mcp-servers/oauth-state";
import { getAppBaseUrl } from "@/lib/config/urls";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async (req: Request) => {
  const admin = await getSessionWithOrgAdmin();
  if (!admin) return NextResponse.json({ error: "Only organization owners and admins can manage MCP servers" }, { status: 403 });
  const { session, orgId } = admin;
  const url = new URL(req.url);
  const serverId = url.searchParams.get("serverId");

  if (!serverId) {
    return NextResponse.json(
      { error: "serverId required" },
      { status: 400 },
    );
  }

  const server = await findMcpServerByIdAndOrg(serverId, orgId);
  if (!server) {
    return NextResponse.json(
      { error: "Server not found" },
      { status: 404 },
    );
  }
  if (server.authType !== "oauth") {
    return NextResponse.json(
      { error: "Not an OAuth server" },
      { status: 400 },
    );
  }
  if (
    !server.oauthClientId ||
    !server.oauthAuthorizationEndpoint ||
    !server.oauthTokenEndpoint
  ) {
    return NextResponse.json(
      { error: "OAuth metadata incomplete" },
      { status: 400 },
    );
  }

  // Generate PKCE
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  // Sign state
  const state = signMcpOAuthState({
    orgId,
    userId: session.user.id,
    serverId,
    nonce: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 300,
  });

  // Build callback URL
  const callbackUrl = `${getAppBaseUrl()}/api/mcp-servers/oauth/callback`;

  // Store PKCE verifier in HttpOnly cookie — per-server name prevents cross-server races
  const cookieName = `mcp_oauth_verifier_${serverId}`;
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `${cookieName}=${codeVerifier}; HttpOnly; SameSite=Lax; Path=/api/mcp-servers/oauth; Max-Age=300` +
      (process.env.NODE_ENV === "production" ? "; Secure" : ""),
  );

  // Build authorization URL
  const authUrl = new URL(server.oauthAuthorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", server.oauthClientId);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  if (server.oauthScopes) {
    authUrl.searchParams.set("scope", server.oauthScopes);
  }

  headers.set("Location", authUrl.toString());
  return new Response(null, { status: 302, headers });
});
