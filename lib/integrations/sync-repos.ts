import { App } from "octokit";
import { db } from "@/lib/db";
import { repositories } from "./schema";
import { findGithubInstallationsByOrg } from "./queries";

function getPrivateKey(): string {
  if (process.env.GITHUB_APP_PRIVATE_KEY_B64) {
    return Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, "base64").toString("utf-8");
  }
  if (process.env.GITHUB_APP_PRIVATE_KEY) {
    return process.env.GITHUB_APP_PRIVATE_KEY;
  }
  throw new Error("Set GITHUB_APP_PRIVATE_KEY_B64 or GITHUB_APP_PRIVATE_KEY");
}

/**
 * Fetch repos from GitHub for all installations in an org and sync to DB.
 * Returns the DB repository rows.
 */
export async function syncReposForOrg(orgId: string) {
  const installations = await findGithubInstallationsByOrg(orgId);
  if (installations.length === 0) return [];

  const app = new App({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: getPrivateKey(),
  });

  for (const inst of installations) {
    try {
      const octokit = await app.getInstallationOctokit(inst.installationId);
      const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({
        per_page: 100,
      });

      for (const repo of data.repositories) {
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
      // Skip installations that fail
    }
  }

  // Return all repos from DB
  const { findRepositoriesByOrg } = await import("./queries");
  return findRepositoriesByOrg(orgId);
}
