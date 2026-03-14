/**
 * Test: Claude Code CLI auth via CLAUDE_CODE_OAUTH_TOKEN inside Vercel Sandbox.
 *
 * Usage:
 *   npx tsx scripts/test-claude-oauth.ts
 *
 * Required env vars:
 *   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 *   CLAUDE_CODE_OAUTH_TOKEN
 */

import { SandboxManager } from "../lib/sandbox/SandboxManager";
import { SandboxCommands } from "../lib/sandbox/SandboxCommands";

async function main() {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthToken) {
    console.error("CLAUDE_CODE_OAUTH_TOKEN is required");
    process.exit(1);
  }

  const manager = new SandboxManager();

  console.log("1. Creating sandbox...");
  const sandbox = await manager.create({
    source: { type: "git" },
    repoUrl: "https://github.com/octocat/Hello-World.git",
    gitToken: "",
    timeoutMs: 120_000,
  });
  console.log(`   Sandbox ID: ${sandbox.sandboxId}`);

  const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);

  try {
    console.log("\n2. Installing Claude CLI...");
    const install = await commands.runShell(
      "curl -fsSL https://claude.ai/install.sh | bash",
      { cwd: "/" },
    );
    if (install.exitCode !== 0) {
      throw new Error(`Install failed: ${install.stderr}`);
    }
    console.log("   Installed.");

    const version = await commands.run("claude", ["--version"]);
    console.log(`   Version: ${version.stdout.trim()}`);

    console.log("\n3. Running claude with CLAUDE_CODE_OAUTH_TOKEN (no ANTHROPIC_API_KEY)...");
    const result = await commands.run(
      "claude",
      ["-p", "Say exactly: hello from oauth", "--dangerously-skip-permissions", "--output-format", "text"],
      {
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        },
      },
    );

    console.log(`   Exit code: ${result.exitCode}`);
    console.log(`   Stdout: ${result.stdout.slice(0, 500)}`);
    if (result.stderr) {
      console.log(`   Stderr: ${result.stderr.slice(0, 500)}`);
    }

    if (result.exitCode === 0) {
      console.log("\n--- PASSED: OAuth token auth works ---");
    } else {
      console.log("\n--- FAILED: Claude CLI returned non-zero exit code ---");
      process.exit(1);
    }
  } finally {
    console.log("\nDestroying sandbox...");
    await manager.destroy(sandbox);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
