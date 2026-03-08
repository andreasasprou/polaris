/**
 * Test: Claude agent execution via Sandbox Agent inside Vercel Sandbox.
 *
 * Usage:
 *   npx tsx scripts/test-agent-claude.ts owner/repo
 *
 * Required env vars:
 *   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY
 *   ANTHROPIC_API_KEY
 */

import { SandboxManager } from "../lib/sandbox/SandboxManager";
import { SandboxCommands } from "../lib/sandbox/SandboxCommands";
import { SandboxAgentBootstrap } from "../lib/sandbox-agent/SandboxAgentBootstrap";
import { SandboxAgentClient } from "../lib/sandbox-agent/SandboxAgentClient";
import { buildSessionEnv } from "../lib/sandbox-agent/credentials";
import { getInstallationToken } from "../lib/integrations/github";

async function main() {
  const repoArg = process.argv[2];
  if (!repoArg || !repoArg.includes("/")) {
    console.error("Usage: npx tsx scripts/test-agent-claude.ts owner/repo");
    process.exit(1);
  }

  const [owner, repo] = repoArg.split("/");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  console.log(`Repo: ${owner}/${repo}`);

  console.log("\n1. Getting installation token...");
  const token = await getInstallationToken(owner, repo);

  const manager = new SandboxManager();

  console.log("\n2. Creating sandbox...");
  const sandbox = await manager.create({
    source: { type: "git" },
    repoUrl: `https://github.com/${owner}/${repo}.git`,
    gitToken: token,
    timeoutMs: 300_000,
    ports: [2468],
  });
  console.log(`   Sandbox ID: ${sandbox.sandboxId}`);

  const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);

  try {
    console.log("\n3. Installing Sandbox Agent...");
    const bootstrap = new SandboxAgentBootstrap(sandbox, commands);
    await bootstrap.install();

    const sessionEnv = buildSessionEnv("claude", apiKey, {
      GITHUB_TOKEN: token,
    });
    await bootstrap.installAgent("claude", sessionEnv);

    console.log("\n4. Starting server...");
    const serverUrl = await bootstrap.start(2468, sessionEnv);
    console.log(`   Server URL: ${serverUrl}`);

    const client = await SandboxAgentClient.connect(serverUrl);

    console.log("\n5. Running Claude agent...");
    const session = await client.createSession({
      agent: "claude",
      mode: "bypassPermissions",
      cwd: SandboxManager.PROJECT_DIR,
    });

    const result = await client.executePrompt(
      session,
      "Add a single-line comment '<!-- Polaris test -->' to the very top of README.md. Do not change anything else.",
      {
        onEvent: (event) => {
          const payload = event.payload as Record<string, unknown>;
          if (payload?.type) {
            console.log(`   [${event.sender}] ${payload.type}`);
          }
        },
      },
    );

    await client.destroySession(session.id);
    await client.dispose();

    console.log(`\n6. Results:`);
    console.log(`   Success: ${result.success}`);
    if (result.error) console.log(`   Error: ${result.error}`);

    // Check for changes via git
    const diff = await commands.runInProject("git", ["diff"]);
    const hasChanges = diff.stdout.trim().length > 0;
    console.log(`   Changes detected: ${hasChanges}`);

    if (hasChanges) {
      console.log(`   ${diff.stdout.slice(0, 500)}`);
    }

    console.log(
      hasChanges ? "\n--- PASSED ---" : "\n--- NO CHANGES (may still be OK) ---",
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
