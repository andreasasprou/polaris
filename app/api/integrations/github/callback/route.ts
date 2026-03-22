import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { headers } from "next/headers";
import { APIError } from "better-auth";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { hasOrganizationMembership, getOrgSlugById } from "@/lib/auth/session";
import { getAppBaseUrl, RESERVED_SLUGS } from "@/lib/config/urls";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/auth-schema";
import { createGitHubApp } from "@/lib/integrations/github";
import { findGithubInstallationsByInstallationId } from "@/lib/integrations/queries";
import { githubInstallations } from "@/lib/integrations/schema";
import { verifyState } from "@/lib/integrations/github-state";
import { withEvlog } from "@/lib/evlog";

function toSlug(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  // Avoid reserved slugs that would conflict with app routes
  if (RESERVED_SLUGS.has(slug)) {
    slug = `${slug}-org`;
  }
  return slug;
}

function redirectWithError(baseUrl: string, path: string, error: string) {
  return NextResponse.redirect(new URL(`${path}?error=${error}`, baseUrl));
}

export const GET = withEvlog(async (req: NextRequest) => {
  const baseUrl = getAppBaseUrl();
  const installationIdParam = req.nextUrl.searchParams.get("installation_id");
  const state = req.nextUrl.searchParams.get("state");

  const installationId = Number(installationIdParam);
  if (
    !installationIdParam
    || !Number.isInteger(installationId)
    || installationId <= 0
  ) {
    return redirectWithError(baseUrl, "/integrations", "missing_params");
  }

  const reqHeaders = await headers();
  const session = await auth.api.getSession({
    headers: reqHeaders,
  }).catch(() => null);

  if (!session) {
    return NextResponse.redirect(new URL("/login", baseUrl));
  }

  const fallbackPath = session.session.activeOrganizationId
    ? "/integrations"
    : "/onboarding";

  if (!state) {
    return redirectWithError(baseUrl, fallbackPath, "invalid_state");
  }

  const payload = verifyState(state);
  if (!payload) {
    return redirectWithError(baseUrl, fallbackPath, "invalid_state");
  }

  if (payload.userId !== session.user.id) {
    return redirectWithError(baseUrl, fallbackPath, "invalid_state");
  }

  let orgId = payload.orgId;
  if (orgId) {
    const hasMembership = await hasOrganizationMembership(session.user.id, orgId);
    if (!hasMembership) {
      return redirectWithError(baseUrl, "/integrations", "org_access_denied");
    }
  }

  const app = createGitHubApp();

  let accountLogin: string | null = null;
  let accountType: string | null = null;

  try {
    const { data: installation } = await app.octokit.rest.apps.getInstallation({
      installation_id: installationId,
    });
    const account = installation.account;
    accountLogin = account && "login" in account ? account.login : (account?.name ?? null);
    accountType = account && "type" in account ? account.type : null;
  } catch {
    // Best-effort — accountLogin/accountType are metadata enrichment, not required.
    // The flow only needs installationId which we already have from the callback.
  }

  let orgCreated = false;
  if (!orgId) {
    const orgName = accountLogin ?? session.user.name ?? "My Organization";
    let slug = toSlug(orgName);

    // Retry with random suffix on slug conflict
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await auth.api.createOrganization({
          body: { name: orgName, slug },
          headers: reqHeaders,
        });
        orgId = result.id;
        orgCreated = true;
        break;
      } catch (err: unknown) {
        const isSlugConflict =
          err instanceof APIError && err.body?.code === "ORGANIZATION_ALREADY_EXISTS";
        if (isSlugConflict && attempt < 2) {
          slug = `${toSlug(orgName)}-${crypto.randomBytes(3).toString("hex")}`;
          continue;
        }
        return redirectWithError(baseUrl, "/onboarding", "org_creation_failed");
      }
    }
  }

  if (!orgId) {
    return redirectWithError(baseUrl, "/onboarding", "no_org");
  }

  const existingInstallations = await findGithubInstallationsByInstallationId(
    installationId,
  );
  const conflictingInstallation = existingInstallations.find(
    (row) => row.organizationId !== orgId,
  );
  if (conflictingInstallation) {
    return redirectWithError(baseUrl, "/integrations", "installation_already_linked");
  }

  const existingInstallation = existingInstallations.find(
    (row) => row.organizationId === orgId,
  );
  if (existingInstallation) {
    // Only overwrite metadata fields if enrichment succeeded — don't clear
    // previously populated values with null on transient GitHub API failures.
    const updates: Record<string, unknown> = { installedBy: session.user.id };
    if (accountLogin != null) updates.accountLogin = accountLogin;
    if (accountType != null) updates.accountType = accountType;
    await db
      .update(githubInstallations)
      .set(updates)
      .where(eq(githubInstallations.id, existingInstallation.id));
  } else {
    await db
      .insert(githubInstallations)
      .values({
        organizationId: orgId,
        installationId,
        accountLogin,
        accountType,
        installedBy: session.user.id,
      });
  }

  const [orgRow] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);

  const meta = orgRow?.metadata
    ? (JSON.parse(orgRow.metadata) as Record<string, unknown>)
    : null;
  const onboardingComplete = !!meta?.onboardingCompletedAt;

  if (!onboardingComplete) {
    const { count } = await import("drizzle-orm");
    const { automations } = await import("@/lib/automations/schema");
    const [result] = await db
      .select({ count: count() })
      .from(automations)
      .where(eq(automations.organizationId, orgId));
    if ((result?.count ?? 0) === 0) {
      return NextResponse.redirect(new URL("/onboarding", baseUrl));
    }
  }

  // Resolve org slug for org-scoped redirect
  let orgSlug: string | undefined;
  try {
    orgSlug = await getOrgSlugById(orgId);
  } catch {
    // Fall back to bare paths — proxy will handle legacy redirect
  }

  if (orgCreated) {
    const path = orgSlug
      ? `/${orgSlug}/dashboard?success=org_created`
      : "/dashboard?success=org_created";
    return NextResponse.redirect(new URL(path, baseUrl));
  }
  const path = orgSlug
    ? `/${orgSlug}/integrations?success=github_installed`
    : "/integrations?success=github_installed";
  return NextResponse.redirect(new URL(path, baseUrl));
});
