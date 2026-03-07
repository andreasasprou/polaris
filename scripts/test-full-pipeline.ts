/**
 * Test: Full pipeline without Slack/Trigger.
 * Sandbox → Agent → Git → PR creation.
 *
 * Usage:
 *   npx tsx scripts/test-full-pipeline.ts owner/repo "your prompt" [--agent claude|codex]
 *
 * Required env vars:
 *   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY
 *   ANTHROPIC_API_KEY (for claude) and/or OPENAI_API_KEY (for codex)
 */

import { SandboxManager } from "../lib/sandbox/SandboxManager";
import { SandboxCommands } from "../lib/sandbox/SandboxCommands";
import { GitOperations } from "../lib/sandbox/GitOperations";
import { AgentRegistry } from "../lib/agents/AgentRegistry";
import type { AgentType } from "../lib/agents/types";
import {
  getInstallationToken,
  createPullRequest,
} from "../lib/integrations/github";

function parseArgs() {
  const args = process.argv.slice(2);
  const repoArg = args[0];
  if (!repoArg || !repoArg.includes("/")) {
    console.error(
      'Usage: npx tsx scripts/test-full-pipeline.ts owner/repo "prompt" [--agent claude|codex]',
    );
    process.exit(1);
  }

  const [owner, repo] = repoArg.split("/");
  const agentFlagIdx = args.indexOf("--agent");
  const agentType: AgentType =
    agentFlagIdx !== -1
      ? (args[agentFlagIdx + 1] as AgentType)
      : "claude";

  const promptParts = args
    .slice(1)
    .filter((_, i) => {
      const absIdx = i + 1;
      return absIdx !== agentFlagIdx && absIdx !== agentFlagIdx + 1;
    });
  const prompt = promptParts.join(" ").trim();

  if (!prompt) {
    console.error("Prompt is required");
    process.exit(1);
  }

  return { owner, repo, prompt, agentType };
}

async function main() {
  const { owner, repo, prompt, agentType } = parseArgs();
  const branchName = `agent/${Date.now()}`;

  console.log(`Repo:   ${owner}/${repo}`);
  console.log(`Agent:  ${agentType}`);
  console.log(`Branch: ${branchName}`);
  console.log(`Prompt: ${prompt}`);

  const apiKey =
    agentType === "claude"
      ? (process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN)
      : (process.env.OPENAI_API_KEY ?? process.env.CODEX_AUTH_JSON_B64);

  if (!apiKey) {
    const keys =
      agentType === "claude"
        ? "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN"
        : "OPENAI_API_KEY or CODEX_AUTH_JSON_B64";
    console.error(`${keys} is required for agent type "${agentType}"`);
    process.exit(1);
  }

  console.log("\n1. Getting installation token...");
  const token = await getInstallationToken(owner, repo);

  const manager = new SandboxManager();

  const repoUrl = `https://github.com/${owner}/${repo}.git`;

  console.log("\n2. Creating sandbox...");
  const sandbox = await manager.create({
    repoUrl,
    gitToken: token,
    timeoutMs: 600_000,
  });
  console.log(`   Sandbox ID: ${sandbox.sandboxId}`);

  const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
  const git = new GitOperations(commands);

  try {
    console.log("\n3. Setting up git branch...");
    await git.configure({ repoUrl, gitToken: token });
    await git.createBranch(branchName, "main");
    const baseSha = await git.resolveRef("origin/main");

    console.log("\n4. Running agent...");
    const agent = AgentRegistry.create(agentType, commands);
    const result = await agent.execute(prompt, { apiKey });

    console.log(`   Success: ${result.success}`);
    console.log(`   Changes detected: ${result.changesDetected}`);
    if (result.error) console.log(`   Error: ${result.error}`);

    if (!result.changesDetected) {
      console.log("\nNo changes made. Skipping PR creation.");
      console.log("\n--- DONE (no changes) ---");
      return;
    }

    console.log("\n5. Checking changes...");
    const changes = await git.checkChanges(baseSha);
    console.log(`   ${changes.diffSummary}`);

    console.log("\n6. Committing and pushing...");
    const gitResult = await git.commitAndPush(branchName, `fix: ${prompt.slice(0, 50)}`, baseSha);
    console.log(`   Commit: ${gitResult.commitSha}`);
    console.log(`   Pushed: ${gitResult.pushed}`);

    if (!gitResult.pushed) {
      console.log("\nPush failed. Cannot create PR.");
      console.log("\n--- DONE (push failed) ---");
      return;
    }

    console.log("\n7. Creating PR...");
    const pr = await createPullRequest({
      owner,
      repo,
      head: branchName,
      base: "main",
      title: `[Polaris] ${prompt.slice(0, 60)}`,
      body: `Automated PR by Polaris using ${agentType} agent.\n\n${changes.diffSummary}`,
    });
    console.log(`   PR #${pr.number}: ${pr.url}`);

    console.log("\n--- PASSED ---");
    console.log(`PR URL: ${pr.url}`);
  } finally {
    console.log("\nDestroying sandbox...");
    await manager.destroy(sandbox);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
