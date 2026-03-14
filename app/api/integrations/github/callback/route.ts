import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { headers } from "next/headers";
import { APIError } from "better-auth";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { githubInstallations } from "@/lib/integrations/schema";
import { verifyState } from "@/lib/integrations/github-state";

function getPrivateKey(): string {
  if (process.env.GITHUB_APP_PRIVATE_KEY_B64) {
    return Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, "base64").toString("utf-8");
  }
  if (process.env.GITHUB_APP_PRIVATE_KEY) {
    return process.env.GITHUB_APP_PRIVATE_KEY;
  }
  throw new Error("Set GITHUB_APP_PRIVATE_KEY_B64 or GITHUB_APP_PRIVATE_KEY");
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function GET(req: NextRequest) {
  const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const installationId = req.nextUrl.searchParams.get("installation_id");
  const state = req.nextUrl.searchParams.get("state");

  if (!installationId) {
    return NextResponse.redirect(new URL("/integrations?error=missing_params", baseUrl));
  }

  // Get current session
  const reqHeaders = await headers();
  const session = await auth.api.getSession({
    headers: reqHeaders,
  }).catch(() => null);

  if (!session) {
    return NextResponse.redirect(new URL("/login", baseUrl));
  }

  // Try to verify signed state if present
  let orgId = session.session.activeOrganizationId ?? null;
  if (state) {
    const payload = verifyState(state);
    if (payload) {
      orgId = payload.orgId;
    }
  }

  // Get installation details from GitHub (moved before orgId check so we have accountLogin)
  const { App } = await import("octokit");
  const app = new App({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: getPrivateKey(),
  });

  let accountLogin: string | null = null;
  let accountType: string | null = null;

  try {
    const { data: installation } = await app.octokit.rest.apps.getInstallation({
      installation_id: Number(installationId),
    });
    const account = installation.account;
    accountLogin = account && "login" in account ? account.login : (account?.name ?? null);
    accountType = account && "type" in account ? account.type : null;
  } catch {
    // Non-critical — we can store the installation without account details
  }

  // Auto-create org if user has none
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
        // If not a slug conflict or exhausted retries, redirect with error
        return NextResponse.redirect(new URL("/onboarding?error=org_creation_failed", baseUrl));
      }
    }
  }

  if (!orgId) {
    return NextResponse.redirect(new URL("/onboarding?error=no_org", baseUrl));
  }

  // Upsert the installation
  await db
    .insert(githubInstallations)
    .values({
      organizationId: orgId,
      installationId: Number(installationId),
      accountLogin,
      accountType,
      installedBy: session.user.id,
    })
    .onConflictDoNothing();

  if (orgCreated) {
    return NextResponse.redirect(new URL("/dashboard?success=org_created", baseUrl));
  }
  return NextResponse.redirect(new URL("/integrations?success=github_installed", baseUrl));
}
