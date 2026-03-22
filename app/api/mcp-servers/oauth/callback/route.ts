import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getOrgSlugById, getSessionWithOrg } from "@/lib/auth/session";
import { updateMcpServerAuth } from "@/lib/mcp-servers/actions";
import { verifyMcpOAuthState } from "@/lib/mcp-servers/oauth-state";
import { findMcpServerByIdAndOrg } from "@/lib/mcp-servers/queries";
import { safeFetch } from "@/lib/mcp-servers/url-validation";
import { orgPath, getAppBaseUrl } from "@/lib/config/urls";
import { db } from "@/lib/db";
import { member } from "@/lib/db/auth-schema";
import { withEvlog } from "@/lib/evlog";

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Access was denied by the provider",
  invalid_scope: "The requested scope is invalid",
  server_error: "The provider encountered an error",
  temporarily_unavailable: "The provider is temporarily unavailable",
};

async function isOrgAdmin(userId: string, orgId: string) {
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, orgId)),
    )
    .limit(1);

  return membership?.role === "owner" || membership?.role === "admin";
}

function getMarketplacePath(orgSlug: string) {
  return orgPath(orgSlug, "/integrations/mcp");
}

function getServerPath(
  orgSlug: string,
  server: { catalogSlug: string | null } | null,
) {
  if (!server?.catalogSlug) {
    return orgPath(orgSlug, "/integrations/mcp/custom");
  }

  return orgPath(orgSlug, `/integrations/mcp/${server.catalogSlug}`);
}

function redirectWithQuery(
  baseUrl: string,
  path: string,
  key: "error" | "success",
  value: string,
) {
  const location = new URL(path, baseUrl);
  location.searchParams.set(key, value);
  return NextResponse.redirect(location);
}

export const GET = withEvlog(async (req: Request) => {
  const { session, orgId } = await getSessionWithOrg();
  const orgSlug = await getOrgSlugById(orgId);
  const baseUrl = getAppBaseUrl();
  const marketplacePath = getMarketplacePath(orgSlug);

  if (!(await isOrgAdmin(session.user.id, orgId))) {
    return redirectWithQuery(baseUrl, marketplacePath, "error", "unauthorized");
  }

  const url = new URL(req.url);

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const safeMessage =
      ERROR_MESSAGES[oauthError] ?? `OAuth error: ${oauthError}`;
    return redirectWithQuery(baseUrl, marketplacePath, "error", safeMessage);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return redirectWithQuery(
      baseUrl,
      marketplacePath,
      "error",
      "missing code or state",
    );
  }

  const payload = verifyMcpOAuthState(state);
  if (!payload) {
    return redirectWithQuery(baseUrl, marketplacePath, "error", "invalid state");
  }
  if (payload.userId !== session.user.id) {
    return redirectWithQuery(baseUrl, marketplacePath, "error", "user mismatch");
  }
  if (payload.orgId !== orgId) {
    return redirectWithQuery(baseUrl, marketplacePath, "error", "org mismatch");
  }

  const server = await findMcpServerByIdAndOrg(payload.serverId, orgId);
  const targetPath = getServerPath(orgSlug, server);

  if (!server || !server.oauthTokenEndpoint || !server.oauthClientId) {
    return redirectWithQuery(baseUrl, targetPath, "error", "server not found");
  }

  const cookiePrefix = `mcp_oauth_verifier_${payload.serverId}=`;
  const codeVerifier = (req.headers.get("cookie") ?? "")
    .split("; ")
    .find((cookie) => cookie.startsWith(cookiePrefix))
    ?.slice(cookiePrefix.length);
  if (!codeVerifier) {
    return redirectWithQuery(
      baseUrl,
      targetPath,
      "error",
      "missing verifier",
    );
  }

  const callbackUrl = `${getAppBaseUrl()}/api/mcp-servers/oauth/callback`;

  let tokenRes: Response;
  try {
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
    return redirectWithQuery(
      baseUrl,
      targetPath,
      "error",
      "Token exchange request failed",
    );
  }

  if (!tokenRes.ok) {
    return redirectWithQuery(
      baseUrl,
      targetPath,
      "error",
      `Token exchange failed: ${tokenRes.status}`,
    );
  }

  const tokens = await tokenRes.json();
  if (!tokens.access_token) {
    return redirectWithQuery(
      baseUrl,
      targetPath,
      "error",
      "no access token in response",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  await updateMcpServerAuth(payload.serverId, orgId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? "",
    expiresAt: tokens.expires_in ? now + tokens.expires_in : now + 3600,
  });

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `mcp_oauth_verifier_${payload.serverId}=; HttpOnly; Path=/api/mcp-servers/oauth; Max-Age=0`,
  );

  const location = new URL(targetPath, baseUrl);
  location.searchParams.set("success", "connected");
  headers.set("Location", location.toString());

  return new Response(null, { status: 302, headers });
});
