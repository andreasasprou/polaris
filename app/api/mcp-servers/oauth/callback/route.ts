import { NextResponse } from "next/server";
import { requireOrgAdmin } from "@/lib/auth/session";
import { findMcpServerByIdAndOrg } from "@/lib/mcp-servers/queries";
import { updateMcpServerAuth } from "@/lib/mcp-servers/actions";
import { verifyMcpOAuthState } from "@/lib/mcp-servers/oauth-state";
import { getAppBaseUrl } from "@/lib/config/urls";
import { withEvlog } from "@/lib/evlog";

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Access was denied by the provider",
  invalid_scope: "The requested scope is invalid",
  server_error: "The provider encountered an error",
  temporarily_unavailable: "The provider is temporarily unavailable",
};

export const GET = withEvlog(async (req: Request) => {
  const { session, orgId } = await requireOrgAdmin();
  const url = new URL(req.url);

  // Check for OAuth error response — normalize to safe error codes
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const safeMessage =
      ERROR_MESSAGES[oauthError] ?? `OAuth error: ${oauthError}`;
    return NextResponse.redirect(
      new URL(
        `/settings/mcp?error=${encodeURIComponent(safeMessage)}`,
        req.url,
      ),
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/settings/mcp?error=missing+code+or+state", req.url),
    );
  }

  // Verify state
  const payload = verifyMcpOAuthState(state);
  if (!payload) {
    return NextResponse.redirect(
      new URL("/settings/mcp?error=invalid+state", req.url),
    );
  }
  if (payload.userId !== session.user.id) {
    return NextResponse.redirect(
      new URL("/settings/mcp?error=user+mismatch", req.url),
    );
  }
  if (payload.orgId !== orgId) {
    return NextResponse.redirect(
      new URL("/settings/mcp?error=org+mismatch", req.url),
    );
  }

  // Load server to get OAuth endpoints
  const server = await findMcpServerByIdAndOrg(payload.serverId, orgId);
  if (!server || !server.oauthTokenEndpoint || !server.oauthClientId) {
    return NextResponse.redirect(
      new URL("/settings/mcp?error=server+not+found", req.url),
    );
  }

  // Read PKCE verifier from cookie
  const cookieName = `mcp_oauth_verifier_${payload.serverId}`;
  const cookies = req.headers.get("cookie") ?? "";
  const verifierMatch = cookies.match(
    new RegExp(`${cookieName}=([^;]+)`),
  );
  if (!verifierMatch) {
    return NextResponse.redirect(
      new URL("/settings/mcp?error=missing+verifier", req.url),
    );
  }
  const codeVerifier = verifierMatch[1];

  // Token exchange
  const callbackUrl = `${getAppBaseUrl()}/api/mcp-servers/oauth/callback`;

  let tokenRes: Response;
  try {
    tokenRes = await fetch(server.oauthTokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl,
        client_id: server.oauthClientId,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.redirect(
      new URL(
        "/settings/mcp?error=Token+exchange+request+failed",
        req.url,
      ),
    );
  }

  if (!tokenRes.ok) {
    return NextResponse.redirect(
      new URL(
        `/settings/mcp?error=${encodeURIComponent(`Token exchange failed: ${tokenRes.status}`)}`,
        req.url,
      ),
    );
  }

  const tokens = await tokenRes.json();
  if (!tokens.access_token) {
    return NextResponse.redirect(
      new URL(
        "/settings/mcp?error=no+access+token+in+response",
        req.url,
      ),
    );
  }

  // Store tokens
  const now = Math.floor(Date.now() / 1000);
  await updateMcpServerAuth(payload.serverId, orgId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? "",
    expiresAt: tokens.expires_in ? now + tokens.expires_in : now + 3600,
  });

  // Clear verifier cookie and redirect
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `${cookieName}=; HttpOnly; Path=/api/mcp-servers/oauth; Max-Age=0`,
  );
  headers.set(
    "Location",
    new URL("/settings/mcp?success=connected", req.url).toString(),
  );
  return new Response(null, { status: 302, headers });
});
