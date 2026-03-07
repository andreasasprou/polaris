/**
 * Test: Git operations inside a Vercel Sandbox.
 *
 * Usage:
 *   npx tsx scripts/test-git.ts owner/repo
 *
 * Required env vars:
 *   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY
 *
 * This will create a temporary branch, push it, then delete it.
 */

import { SandboxManager } from "../lib/sandbox/SandboxManager";
import { SandboxCommands } from "../lib/sandbox/SandboxCommands";
import { GitOperations } from "../lib/sandbox/GitOperations";
import { getInstallationToken } from "../lib/integrations/github";

async function main() {
  const repoArg = process.argv[2];
  if (!repoArg || !repoArg.includes("/")) {
    console.error("Usage: npx tsx scripts/test-git.ts owner/repo");
    process.exit(1);
  }

  const [owner, repo] = repoArg.split("/");
  const branchName = `agent/test-git-${Date.now()}`;

  console.log(`Repo: ${owner}/${repo}`);
  console.log(`Branch: ${branchName}`);

  console.log("\n1. Getting installation token...");
  const token = await getInstallationToken(owner, repo);
  console.log("   Token acquired.");

  const manager = new SandboxManager();

  console.log("\n2. Creating sandbox with repo...");
  const sandbox = await manager.create({
    repoUrl: `https://github.com/${owner}/${repo}.git`,
    gitToken: token,
    timeoutMs: 180_000,
  });
  console.log(`   Sandbox ID: ${sandbox.sandboxId}`);

  const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
  const git = new GitOperations(commands);

  try {
    console.log("\n3. Configuring git...");
    await git.configure({
      repoUrl: `https://github.com/${owner}/${repo}.git`,
      gitToken: token,
    });

    console.log("\n4. Creating branch...");
    await git.createBranch(branchName, "main");
    const baseSha = await git.resolveRef("origin/main");

    console.log("\n5. Writing a test file...");
    await commands.runShell(
      `echo "Test file from Polaris at $(date)" > polaris-test.txt`,
    );

    console.log("\n6. Checking changes...");
    const changes = await git.checkChanges(baseSha);
    console.log(`   Changed: ${changes.changed}`);
    console.log(`   Files: ${changes.filesChanged.join(", ")}`);

    console.log("\n7. Committing and pushing...");
    const result = await git.commitAndPush(
      branchName,
      "test: polaris git operations",
      baseSha,
    );
    console.log(`   Commit SHA: ${result.commitSha}`);
    console.log(`   Pushed: ${result.pushed}`);

    console.log("\n8. Getting log...");
    const log = await git.getLog(3);
    console.log(`   ${log}`);

    console.log("\n9. Cleaning up remote branch...");
    await commands.runInProject("git", [
      "push",
      "origin",
      "--delete",
      branchName,
    ]);
    console.log("   Branch deleted.");

    console.log("\n--- PASSED ---");
  } finally {
    console.log("\nDestroying sandbox...");
    await manager.destroy(sandbox);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
