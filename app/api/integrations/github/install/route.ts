import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import crypto from "node:crypto";
import { auth } from "@/lib/auth";
import { getAppBaseUrl } from "@/lib/config/urls";
import { signState } from "@/lib/integrations/github-state";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async (req: NextRequest) => {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return NextResponse.redirect(new URL("/login", getAppBaseUrl()));
  }

  // When creating a new org, pass null so the callback creates one
  const isCreateNew = req.nextUrl.searchParams.get("create") === "true";
  const orgId = isCreateNew ? null : (session.session.activeOrganizationId ?? null);

  const state = signState({
    orgId,
    userId: session.user.id,
    nonce: crypto.randomBytes(16).toString("hex"),
    exp: Math.floor(Date.now() / 1000) + 300, // 5 min
  });

  const githubAppSlug = process.env.GITHUB_APP_SLUG;
  if (!githubAppSlug) {
    throw new Error("GITHUB_APP_SLUG environment variable is required");
  }
  const installUrl = `https://github.com/apps/${githubAppSlug}/installations/new?state=${encodeURIComponent(state)}`;

  return NextResponse.redirect(installUrl);
});
