import { NextResponse } from "next/server";
import { headers } from "next/headers";
import crypto from "node:crypto";
import { auth } from "@/lib/auth";
import { signState } from "@/lib/integrations/github-state";

export async function GET() {
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

  const githubAppSlug = process.env.GITHUB_APP_SLUG ?? "polaris-agent";
  const installUrl = `https://github.com/apps/${githubAppSlug}/installations/new?state=${encodeURIComponent(state)}`;

  return NextResponse.redirect(installUrl);
}
