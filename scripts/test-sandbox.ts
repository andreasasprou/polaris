/**
 * Test: Vercel Sandbox SDK connectivity and basic operations.
 *
 * Usage:
 *   npx tsx scripts/test-sandbox.ts
 *
 * Required env vars:
 *   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 */

import { SandboxManager } from "../lib/sandbox/SandboxManager";
import { SandboxCommands } from "../lib/sandbox/SandboxCommands";

async function main() {
  const manager = new SandboxManager();

  console.log("1. Creating sandbox...");
  const sandbox = await manager.create({
    repoUrl: "https://github.com/octocat/Hello-World.git",
    gitToken: "",
    timeoutMs: 120_000,
  });
  console.log(`   Sandbox ID: ${sandbox.sandboxId}`);
  console.log(`   Status: ${sandbox.status}`);

  const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);

  console.log("\n2. Running 'echo hello'...");
  const echo = await commands.run("echo", ["hello from sandbox"]);
  console.log(`   Exit code: ${echo.exitCode}`);
  console.log(`   Stdout: ${echo.stdout.trim()}`);

  console.log("\n3. Checking runtime...");
  const node = await commands.run("node", ["--version"]);
  console.log(`   Node: ${node.stdout.trim()}`);

  const git = await commands.run("git", ["--version"]);
  console.log(`   Git: ${git.stdout.trim()}`);

  console.log("\n4. Listing project files...");
  const ls = await commands.runInProject("ls", ["-la"]);
  console.log(`   ${ls.stdout.trim()}`);

  console.log("\n5. Destroying sandbox...");
  await manager.destroy(sandbox);
  console.log("   Done.");

  console.log("\n--- PASSED ---");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
