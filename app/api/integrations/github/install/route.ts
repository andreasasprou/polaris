import { NextResponse } from "next/server";
import { headers } from "next/headers";
import crypto from "node:crypto";
import { auth } from "@/lib/auth";

export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return NextResponse.redirect(new URL("/login", process.env.APP_BASE_URL ?? "http://localhost:3000"));
  }

  const orgId = session.session.activeOrganizationId;
  if (!orgId) {
    return NextResponse.redirect(new URL("/onboarding", process.env.APP_BASE_URL ?? "http://localhost:3000"));
  }

  // Build signed state JWT-like payload
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = {
    orgId,
    userId: session.user.id,
    nonce,
    exp: Math.floor(Date.now() / 1000) + 300, // 5 min
  };

  // Simple HMAC-signed state (not a full JWT, but sufficient for MVP)
  const stateData = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const hmac = crypto
    .createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
    .update(stateData)
    .digest("base64url");
  const state = `${stateData}.${hmac}`;

  const githubAppSlug = process.env.GITHUB_APP_SLUG ?? "polaris-agent";
  const installUrl = `https://github.com/apps/${githubAppSlug}/installations/new?state=${encodeURIComponent(state)}`;

  return NextResponse.redirect(installUrl);
}
