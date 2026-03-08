import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { App } from "octokit";
import { auth } from "@/lib/auth";
import { findGithubInstallationsByOrg } from "@/lib/integrations/queries";
import { db } from "@/lib/db";
import { repositories } from "@/lib/integrations/schema";

function getPrivateKey(): string {
  if (process.env.GITHUB_APP_PRIVATE_KEY_B64) {
    return Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, "base64").toString("utf-8");
  }
  if (process.env.GITHUB_APP_PRIVATE_KEY) {
    return process.env.GITHUB_APP_PRIVATE_KEY;
  }
  throw new Error("Set GITHUB_APP_PRIVATE_KEY_B64 or GITHUB_APP_PRIVATE_KEY");
}

export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.session.activeOrganizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgId = session.session.activeOrganizationId;
  const installations = await findGithubInstallationsByOrg(orgId);

  if (installations.length === 0) {
    return NextResponse.json({ repos: [] });
  }

  const app = new App({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: getPrivateKey(),
  });

  const allRepos: Array<{
    installationId: string;
    owner: string;
    name: string;
    fullName: string;
    defaultBranch: string;
    private: boolean;
  }> = [];

  for (const inst of installations) {
    try {
      const octokit = await app.getInstallationOctokit(inst.installationId);
      const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({
        per_page: 100,
      });

      for (const repo of data.repositories) {
        allRepos.push({
          installationId: inst.id,
          owner: repo.owner.login,
          name: repo.name,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch,
          private: repo.private,
        });

        // Sync to DB
        await db
          .insert(repositories)
          .values({
            organizationId: orgId,
            githubInstallationId: inst.id,
            owner: repo.owner.login,
            name: repo.name,
            defaultBranch: repo.default_branch,
          })
          .onConflictDoNothing();
      }
    } catch {
      // Skip installations that fail (e.g., suspended)
    }
  }

  return NextResponse.json({ repos: allRepos });
}
