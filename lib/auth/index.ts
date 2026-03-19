import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db";

function buildTrustedOrigins(): string[] {
  const origins: string[] = [];

  if (process.env.NODE_ENV === "production") {
    origins.push("https://*.vercel.app");
  } else {
    // In development, trust the exact origin from BETTER_AUTH_URL
    // (set by the boot script to match the worktree's port).
    // Fall back to common local ports for manual `pnpm dev`.
    const authUrl = process.env.BETTER_AUTH_URL;
    if (authUrl) {
      origins.push(authUrl);
    } else {
      origins.push("http://localhost:3000", "http://localhost:3001");
    }
  }

  return origins;
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  account: {
    encryptOAuthTokens: true,
  },
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: buildTrustedOrigins(),
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      scope: ["user:email"],
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      creatorRole: "owner",
    }),
    nextCookies(), // must be last
  ],
});
