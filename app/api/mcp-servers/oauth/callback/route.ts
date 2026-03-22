import { NextResponse } from "next/server";
import { getSessionWithOrgAdmin, getOrgSlugById } from "@/lib/auth/session";
import { findMcpServerByIdAndOrg } from "@/lib/mcp-servers/queries";
import { updateMcpServerAuth } from "@/lib/mcp-servers/actions";
import { verifyMcpOAuthState } from "@/lib/mcp-servers/oauth-state";
import { safeFetch } from "@/lib/mcp-servers/url-validation";
import { getAppBaseUrl } from "@/lib/config/urls";
import { withEvlog } from "@/lib/evlog";

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Access was denied by the provider",
  invalid_scope: "The requested scope is invalid",
  server_error: "The provider encountered an error",
  temporarily_unavailable: "The provider is temporarily unavailable",
};

export const GET = withEvlog(async (req: Request) => {
  const admin = await getSessionWithOrgAdmin();
  if (!admin) return NextResponse.redirect(new URL("/settings/mcp?error=unauthorized", req.url));
  const { session, orgId } = admin;
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

  // Read PKCE verifier from cookie (no regex — split and match by prefix)
  const cookiePrefix = `mcp_oauth_verifier_${payload.serverId}=`;
  const codeVerifier = (req.headers.get("cookie") ?? "")
    .split("; ")
    .find((c) => c.startsWith(cookiePrefix))
    ?.slice(cookiePrefix.length);
  if (!codeVerifier) {
    return NextResponse.redirect(
      new URL("/settings/mcp?error=missing+verifier", req.url),
    );
  }

  // Token exchange
  const callbackUrl = `${getAppBaseUrl()}/api/mcp-servers/oauth/callback`;

  let tokenRes: Response;
  try {
    // Use safeFetch to re-validate DNS + block redirect-based SSRF
    tokenRes = await safeFetch(server.oauthTokenEndpoint, {
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
  let successPath = "/settings/mcp?success=connected";
  try {
    const slug = await getOrgSlugById(orgId);
    successPath = `/${slug}/settings/mcp?success=connected`;
  } catch {
    // Fall back to bare path — proxy will handle legacy redirect
  }

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `mcp_oauth_verifier_${payload.serverId}=; HttpOnly; Path=/api/mcp-servers/oauth; Max-Age=0`,
  );
  headers.set(
    "Location",
    new URL(successPath, req.url).toString(),
  );
  return new Response(null, { status: 302, headers });
});
