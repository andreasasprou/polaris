import { NextResponse } from "next/server";
import { headers } from "next/headers";
import crypto from "node:crypto";
import { auth } from "@/lib/auth";
import { signState } from "@/lib/integrations/github-state";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async () => {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return NextResponse.redirect(new URL("/login", process.env.APP_BASE_URL ?? "http://localhost:3000"));
  }

  const state = signState({
    orgId: session.session.activeOrganizationId ?? null,
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
