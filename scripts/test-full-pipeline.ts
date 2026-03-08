/**
 * Test: Full pipeline without Slack/Trigger.
 * Sandbox → Sandbox Agent → Git → PR creation.
 *
 * Usage:
 *   npx tsx scripts/test-full-pipeline.ts owner/repo "your prompt" [--agent claude|codex|opencode|amp]
 *
 * Required env vars:
 *   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY
 *   ANTHROPIC_API_KEY (for claude) and/or OPENAI_API_KEY (for codex)
 */

import { SandboxManager } from "../lib/sandbox/SandboxManager";
import { SandboxCommands } from "../lib/sandbox/SandboxCommands";
import { GitOperations } from "../lib/sandbox/GitOperations";
import { SandboxAgentBootstrap } from "../lib/sandbox-agent/SandboxAgentBootstrap";
import { SandboxAgentClient } from "../lib/sandbox-agent/SandboxAgentClient";
import { buildSessionEnv } from "../lib/sandbox-agent/credentials";
import type { AgentType } from "../lib/sandbox-agent/types";
import {
  getInstallationToken,
  createPullRequest,
} from "../lib/integrations/github";

function parseArgs() {
  const args = process.argv.slice(2);
  const repoArg = args[0];
  if (!repoArg || !repoArg.includes("/")) {
    console.error(
      'Usage: npx tsx scripts/test-full-pipeline.ts owner/repo "prompt" [--agent claude|codex|opencode|amp]',
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
    source: { type: "git" },
    repoUrl,
    gitToken: token,
    timeoutMs: 600_000,
    ports: [2468],
  });
  console.log(`   Sandbox ID: ${sandbox.sandboxId}`);

  const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
  const git = new GitOperations(commands);

  try {
    console.log("\n3. Setting up git branch...");
    await git.configure({ repoUrl, gitToken: token });
    await git.createBranch(branchName, "main");
    const baseSha = await git.resolveRef("origin/main");

    console.log("\n4. Installing Sandbox Agent...");
    const bootstrap = new SandboxAgentBootstrap(sandbox, commands);
    await bootstrap.install();

    const sessionEnv = buildSessionEnv(agentType, apiKey, {
      GITHUB_TOKEN: token,
    });

    await bootstrap.installAgent(agentType, sessionEnv);

    console.log("\n5. Starting Sandbox Agent server...");
    const serverUrl = await bootstrap.start(2468, sessionEnv);
    console.log(`   Server URL: ${serverUrl}`);

    const client = await SandboxAgentClient.connect(serverUrl);

    console.log("\n6. Running agent session...");
    const session = await client.createSession({
      agent: agentType,
      mode: agentType === "codex" ? "full-access" : "bypassPermissions",
      cwd: SandboxManager.PROJECT_DIR,
    });
    console.log(`   Session ID: ${session.id}`);

    const result = await client.executePrompt(session, prompt, {
      onEvent: (event) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload?.type) {
          console.log(`   [${event.sender}] ${payload.type}`);
        }
      },
    });

    await client.destroySession(session.id);
    await client.dispose();

    console.log(`   Success: ${result.success}`);
    if (result.error) console.log(`   Error: ${result.error}`);

    // Check for changes via git
    await git.ensureBranch(branchName);
    const changes = await git.checkChanges(baseSha);

    if (!changes.changed) {
      console.log("\nNo changes made. Skipping PR creation.");
      console.log("\n--- DONE (no changes) ---");
      return;
    }

    console.log("\n7. Checking changes...");
    console.log(`   ${changes.diffSummary}`);

    console.log("\n8. Committing and pushing...");
    const gitResult = await git.commitAndPush(branchName, `fix: ${prompt.slice(0, 50)}`, baseSha);
    console.log(`   Commit: ${gitResult.commitSha}`);
    console.log(`   Pushed: ${gitResult.pushed}`);

    if (!gitResult.pushed) {
      console.log("\nPush failed. Cannot create PR.");
      console.log("\n--- DONE (push failed) ---");
      return;
    }

    console.log("\n9. Creating PR...");
    const pr = await createPullRequest({
      owner,
      repo,
      head: branchName,
      base: "main",
      title: `[Polaris] ${prompt.slice(0, 60)}`,
      body: `Automated PR by Polaris using ${agentType} agent (via Sandbox Agent).\n\n${changes.diffSummary}`,
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
