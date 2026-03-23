import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getOrgSlugById, hasOrganizationMembership } from "@/lib/auth/session";
import { updateMcpServerAuth } from "@/lib/mcp-servers/actions";
import { verifyMcpOAuthState } from "@/lib/mcp-servers/oauth-state";
import { findMcpServerByIdAndOrg } from "@/lib/mcp-servers/queries";
import { safeFetch } from "@/lib/mcp-servers/url-validation";
import { orgPath, getAppBaseUrl } from "@/lib/config/urls";
import { db } from "@/lib/db";
import { member } from "@/lib/db/auth-schema";
import { withEvlog } from "@/lib/evlog";
import { createMcpOAuthTokenParams } from "@/lib/mcp-servers/oauth-resource";

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

async function getFallbackMarketplacePath(activeOrgId: string | null | undefined) {
  if (!activeOrgId) {
    return "/onboarding";
  }

  const activeOrgSlug = await getOrgSlugById(activeOrgId).catch(() => null);
  return activeOrgSlug ? getMarketplacePath(activeOrgSlug) : "/integrations";
}

export const GET = withEvlog(async (req: Request) => {
  const baseUrl = getAppBaseUrl();
  const reqHeaders = await headers();
  const session = await auth.api.getSession({ headers: reqHeaders }).catch(() => null);

  if (!session) {
    return NextResponse.redirect(new URL("/login", baseUrl));
  }

  const fallbackMarketplacePath = await getFallbackMarketplacePath(
    session.session.activeOrganizationId,
  );
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  let trustedPayload = state ? verifyMcpOAuthState(state) : null;
  if (trustedPayload && trustedPayload.userId !== session.user.id) {
    trustedPayload = null;
  }

  let trustedOrgSlug: string | null = null;
  let trustedServer: Awaited<ReturnType<typeof findMcpServerByIdAndOrg>> | null = null;
  let errorPath = fallbackMarketplacePath;
  if (
    trustedPayload
    && await hasOrganizationMembership(session.user.id, trustedPayload.orgId)
  ) {
    trustedOrgSlug = await getOrgSlugById(trustedPayload.orgId).catch(() => null);
    if (trustedOrgSlug) {
      trustedServer = await findMcpServerByIdAndOrg(
        trustedPayload.serverId,
        trustedPayload.orgId,
      );
      errorPath = getServerPath(trustedOrgSlug, trustedServer);
    }
  } else {
    trustedPayload = null;
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const safeMessage =
      ERROR_MESSAGES[oauthError] ?? `OAuth error: ${oauthError}`;
    return redirectWithQuery(baseUrl, errorPath, "error", safeMessage);
  }

  const code = url.searchParams.get("code");
  if (!code || !state) {
    return redirectWithQuery(
      baseUrl,
      fallbackMarketplacePath,
      "error",
      "missing code or state",
    );
  }

  const payload = trustedPayload;
  if (!payload || !trustedOrgSlug) {
    return redirectWithQuery(
      baseUrl,
      fallbackMarketplacePath,
      "error",
      "invalid state",
    );
  }

  const targetPath = getServerPath(trustedOrgSlug, trustedServer);

  if (!(await isOrgAdmin(session.user.id, payload.orgId))) {
    return redirectWithQuery(baseUrl, targetPath, "error", "unauthorized");
  }

  const server = trustedServer ?? await findMcpServerByIdAndOrg(
    payload.serverId,
    payload.orgId,
  );

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
      body: createMcpOAuthTokenParams(server.serverUrl, {
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
  await updateMcpServerAuth(payload.serverId, payload.orgId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? "",
    expiresAt: tokens.expires_in ? now + tokens.expires_in : now + 3600,
  });

  const responseHeaders = new Headers();
  responseHeaders.append(
    "Set-Cookie",
    `mcp_oauth_verifier_${payload.serverId}=; HttpOnly; Path=/api/mcp-servers/oauth; Max-Age=0`,
  );

  const location = new URL(targetPath, baseUrl);
  location.searchParams.set("success", "connected");
  responseHeaders.set("Location", location.toString());

  return new Response(null, { status: 302, headers: responseHeaders });
});
