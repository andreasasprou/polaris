/**
 * Test: Codex CLI agent execution inside Vercel Sandbox.
 *
 * Usage:
 *   npx tsx scripts/test-agent-codex.ts owner/repo
 *
 * Required env vars:
 *   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY
 *   OPENAI_API_KEY
 */

import { SandboxManager } from "../lib/sandbox/SandboxManager";
import { SandboxCommands } from "../lib/sandbox/SandboxCommands";
import { CodexAgent } from "../lib/agents/CodexAgent";
import { getInstallationToken } from "../lib/integrations/github";

async function main() {
  const repoArg = process.argv[2];
  if (!repoArg || !repoArg.includes("/")) {
    console.error("Usage: npx tsx scripts/test-agent-codex.ts owner/repo");
    process.exit(1);
  }

  const [owner, repo] = repoArg.split("/");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is required");
    process.exit(1);
  }

  console.log(`Repo: ${owner}/${repo}`);

  console.log("\n1. Getting installation token...");
  const token = await getInstallationToken(owner, repo);

  const manager = new SandboxManager();

  console.log("\n2. Creating sandbox...");
  const sandbox = await manager.create({
    repoUrl: `https://github.com/${owner}/${repo}.git`,
    gitToken: token,
    timeoutMs: 300_000,
  });
  console.log(`   Sandbox ID: ${sandbox.sandboxId}`);

  const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
  const agent = new CodexAgent(commands);

  try {
    console.log("\n3. Executing Codex agent...");
    console.log('   Prompt: "Add a comment to the top of README.md"');

    const result = await agent.execute(
      "Add a single-line comment '<!-- Polaris test -->' to the very top of README.md. Do not change anything else.",
      { apiKey },
    );

    console.log(`\n4. Results:`);
    console.log(`   Success: ${result.success}`);
    console.log(`   Changes detected: ${result.changesDetected}`);
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
    console.log(
      `   Output length: ${result.output.length} chars`,
    );

    if (result.changesDetected) {
      console.log("\n5. Checking diff...");
      const diff = await commands.runInProject("git", ["diff"]);
      console.log(`   ${diff.stdout.slice(0, 500)}`);
    }

    console.log(
      result.changesDetected ? "\n--- PASSED ---" : "\n--- NO CHANGES (may still be OK) ---",
    );
  } finally {
    console.log("\nDestroying sandbox...");
    await manager.destroy(sandbox);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
