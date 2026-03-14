/**
 * Test: Codex CLI auth via auth.json (ChatGPT OAuth) inside Vercel Sandbox.
 *
 * Usage:
 *   npx tsx scripts/test-codex-oauth.ts
 *
 * Required env vars:
 *   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 *   CODEX_AUTH_JSON_B64  (base64-encoded ~/.codex/auth.json)
 */

import { SandboxManager } from "../lib/sandbox/SandboxManager";
import { SandboxCommands } from "../lib/sandbox/SandboxCommands";

async function main() {
  const authB64 = process.env.CODEX_AUTH_JSON_B64;
  if (!authB64) {
    console.error("CODEX_AUTH_JSON_B64 is required");
    console.error('Generate with: export CODEX_AUTH_JSON_B64="$(base64 < ~/.codex/auth.json | tr -d \'\\n\')"');
    process.exit(1);
  }

  const manager = new SandboxManager();

  console.log("1. Creating sandbox...");
  const sandbox = await manager.create({
    source: { type: "git" },
    repoUrl: "https://github.com/octocat/Hello-World.git",
    gitToken: "",
    timeoutMs: 180_000,
  });
  console.log(`   Sandbox ID: ${sandbox.sandboxId}`);

  const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);

  try {
    console.log("\n2. Installing Codex CLI...");
    const install = await commands.run("npm", ["install", "-g", "@openai/codex"], { cwd: "/" });
    if (install.exitCode !== 0) {
      throw new Error(`Install failed: ${install.stderr}`);
    }
    console.log("   Installed.");

    const version = await commands.run("codex", ["--version"]);
    console.log(`   Version: ${version.stdout.trim()}`);

    console.log("\n3. Writing auth.json...");
    await commands.runShell(
      `mkdir -p $HOME/.codex && echo '${authB64}' | base64 -d > $HOME/.codex/auth.json`,
      { cwd: "/" },
    );

    // Verify it was written
    const cat = await commands.runShell("cat $HOME/.codex/auth.json | head -c 100", { cwd: "/" });
    console.log(`   auth.json starts with: ${cat.stdout.slice(0, 60)}...`);

    console.log("\n4. Writing config.toml...");
    await commands.runShell(
      `printf 'model = "gpt-5.3-codex"\\napproval_policy = "never"\\nsandbox_mode = "danger-full-access"\\n' > $HOME/.codex/config.toml`,
      { cwd: "/" },
    );

    console.log("\n5. Running codex with auth.json (no OPENAI_API_KEY)...");
    const result = await commands.run(
      "codex",
      ["exec", "--dangerously-bypass-approvals-and-sandbox", "Say exactly: hello from codex oauth"],
      {},
    );

    console.log(`   Exit code: ${result.exitCode}`);
    console.log(`   Stdout: ${result.stdout.slice(0, 500)}`);
    if (result.stderr) {
      console.log(`   Stderr: ${result.stderr.slice(0, 500)}`);
    }

    if (result.exitCode === 0) {
      console.log("\n--- PASSED: Codex auth.json auth works ---");
    } else {
      console.log("\n--- FAILED: Codex CLI returned non-zero exit code ---");
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
