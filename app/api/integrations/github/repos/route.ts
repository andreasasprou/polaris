import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findGithubInstallationsByOrg } from "@/lib/integrations/queries";
import { db } from "@/lib/db";
import { createGitHubApp } from "@/lib/integrations/github";
import { repositories } from "@/lib/integrations/schema";

export async function GET() {
  const { orgId } = await getSessionWithOrg();

  const installations = await findGithubInstallationsByOrg(orgId);

  if (installations.length === 0) {
    return NextResponse.json({ repos: [] });
  }

  const app = createGitHubApp();

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
