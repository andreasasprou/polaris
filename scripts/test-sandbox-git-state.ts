/**
 * Diagnostic: inspect git state inside sandbox after clone + configure.
 */

import { SandboxManager } from "../lib/sandbox/SandboxManager";
import { SandboxCommands } from "../lib/sandbox/SandboxCommands";
import { GitOperations } from "../lib/sandbox/GitOperations";
import { getInstallationToken } from "../lib/integrations/github";

async function main() {
  const owner = "andreasasprou";
  const repo = "polaris";
  const repoUrl = `https://github.com/${owner}/${repo}.git`;

  const token = await getInstallationToken(owner, repo);
  const manager = new SandboxManager();

  const sandbox = await manager.create({
    source: { type: "git" },
    repoUrl,
    gitToken: token,
    timeoutMs: 120_000,
  });

  const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
  const git = new GitOperations(commands);

  try {
    console.log("=== BEFORE configure ===");
    const r1 = await commands.runInProject("git", ["remote", "-v"]);
    console.log("remotes:", r1.stdout);
    const r2 = await commands.runInProject("git", ["branch", "-a"]);
    console.log("branches:", r2.stdout);
    const r3 = await commands.runInProject("git", ["log", "--oneline", "-3"]);
    console.log("log:", r3.stdout);

    console.log("\n=== configure + createBranch ===");
    await git.configure({ repoUrl });
    await git.createBranch("agent/diag-test", "main");
    const baseSha = await git.resolveRef("origin/main");

    const r4 = await commands.runInProject("git", ["remote", "-v"]);
    console.log("remotes:", r4.stdout);
    const r5 = await commands.runInProject("git", ["branch", "-a"]);
    console.log("branches:", r5.stdout);

    console.log("\n=== write a file, then checkChanges ===");
    await commands.runShell("echo 'test' > diag-test.txt");

    const changes = await git.checkChanges(baseSha);
    console.log("changed:", changes.changed);
    console.log("diffSummary:", changes.diffSummary);
    console.log("filesChanged:", changes.filesChanged);

    console.log("\n=== simulate agent committing ===");
    await commands.runInProject("git", ["add", "-A"]);
    await commands.runInProject("git", ["commit", "-m", "agent commit"]);

    const changes2 = await git.checkChanges(baseSha);
    console.log("changed (after agent commit):", changes2.changed);
    console.log("diffSummary:", changes2.diffSummary);
    console.log("filesChanged:", changes2.filesChanged);

    // Also check raw commands
    const logDiff = await commands.runInProject("git", ["log", "origin/main..HEAD", "--oneline"]);
    console.log("\nlog origin/main..HEAD:", logDiff.stdout || "(empty)");
    console.log("stderr:", logDiff.stderr || "(none)");

    const diffStat = await commands.runInProject("git", ["diff", "origin/main", "--stat"]);
    console.log("diff origin/main --stat:", diffStat.stdout || "(empty)");
    console.log("stderr:", diffStat.stderr || "(none)");
  } finally {
    await manager.destroy(sandbox);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
