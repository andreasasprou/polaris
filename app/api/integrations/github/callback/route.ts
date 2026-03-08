import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { githubInstallations } from "@/lib/integrations/schema";

function verifyState(state: string): { orgId: string; userId: string; nonce: string } | null {
  try {
    const parts = state.split(".");
    if (parts.length !== 2) return null;

    const [stateData, hmac] = parts;
    const expectedHmac = crypto
      .createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
      .update(stateData)
      .digest("base64url");

    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(stateData, "base64url").toString());

    // Check expiry
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function getPrivateKey(): string {
  if (process.env.GITHUB_APP_PRIVATE_KEY_B64) {
    return Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, "base64").toString("utf-8");
  }
  if (process.env.GITHUB_APP_PRIVATE_KEY) {
    return process.env.GITHUB_APP_PRIVATE_KEY;
  }
  throw new Error("Set GITHUB_APP_PRIVATE_KEY_B64 or GITHUB_APP_PRIVATE_KEY");
}

export async function GET(req: NextRequest) {
  const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const installationId = req.nextUrl.searchParams.get("installation_id");
  const state = req.nextUrl.searchParams.get("state");

  if (!installationId) {
    return NextResponse.redirect(new URL("/integrations?error=missing_params", baseUrl));
  }

  // Get current session
  const session = await auth.api.getSession({
    headers: await headers(),
  }).catch(() => null);

  if (!session) {
    return NextResponse.redirect(new URL("/login", baseUrl));
  }

  // Try to verify signed state if present
  let orgId = session.session.activeOrganizationId;
  if (state) {
    const payload = verifyState(state);
    if (payload) {
      // Use the org from the signed state
      orgId = payload.orgId;
    }
    // If state verification fails, fall back to active org
  }

  if (!orgId) {
    return NextResponse.redirect(new URL("/onboarding?error=no_org", baseUrl));
  }

  // Get installation details from GitHub
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

  return NextResponse.redirect(new URL("/integrations?success=github_installed", baseUrl));
}
