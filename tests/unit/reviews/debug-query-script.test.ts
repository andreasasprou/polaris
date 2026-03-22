import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve("scripts/debug-query.sh");
const tempDirs = new Set<string>();

function writeExecutable(filePath: string, content: string) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function setupDebugQueryHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-query-script-"));
  tempDirs.add(tempDir);
  const binDir = path.join(tempDir, "bin");
  const outputDir = path.join(tempDir, "output");
  fs.mkdirSync(binDir);
  fs.mkdirSync(outputDir);

  writeExecutable(
    path.join(binDir, "op"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"label=username"*) printf 'readonly_user' ;;
  *"label=password"*) printf 'readonly_password' ;;
  *"label=hostname"*) printf 'db.example.com' ;;
  *"label=database"*) printf 'polaris' ;;
  *) echo "unexpected op invocation: $*" >&2; exit 1 ;;
esac
`,
  );

  writeExecutable(
    path.join(binDir, "psql"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "\${PGOPTIONS:-}" > "$TEST_OUTPUT_DIR/pgoptions"
printf '%s\\n' "$@" > "$TEST_OUTPUT_DIR/args"
cat > "$TEST_OUTPUT_DIR/stdin"
`,
  );

  return { tempDir, binDir, outputDir };
}

function runDebugQuery(
  args: string[],
  options?: { input?: string; env?: Record<string, string> },
) {
  const harness = setupDebugQueryHarness();
  const result = spawnSync("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: options?.input,
    env: {
      ...process.env,
      ...options?.env,
      PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
      TEST_OUTPUT_DIR: harness.outputDir,
    },
  });

  const readOutput = (name: string) =>
    fs.existsSync(path.join(harness.outputDir, name))
      ? fs.readFileSync(path.join(harness.outputDir, name), "utf8")
      : "";

  return {
    ...harness,
    result,
    argsOutput: readOutput("args"),
    pgOptionsOutput: readOutput("pgoptions"),
    stdinOutput: readOutput("stdin"),
  };
}

afterEach(() => {
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDirs.delete(tempDir);
  }
});

describe("scripts/debug-query.sh", () => {
  it("enforces read-only settings for inline queries", () => {
    const execution = runDebugQuery(["SELECT 1"]);

    expect(execution.result.status).toBe(0);
    expect(execution.pgOptionsOutput).toContain("default_transaction_read_only=on");
    expect(execution.argsOutput).toContain("-X");
    expect(execution.argsOutput).toContain("-v");
    expect(execution.argsOutput).toContain("ON_ERROR_STOP=1");
    expect(execution.argsOutput).toContain("-c");
    expect(execution.argsOutput).toContain("SELECT 1");
  });

  it("preserves existing PGOPTIONS while adding read-only mode", () => {
    const execution = runDebugQuery(["SELECT 1"], {
      env: { PGOPTIONS: "-c statement_timeout=5000" },
    });

    expect(execution.result.status).toBe(0);
    expect(execution.pgOptionsOutput).toContain("statement_timeout=5000");
    expect(execution.pgOptionsOutput).toContain("default_transaction_read_only=on");
  });

  it("applies the same protections to file and stdin execution modes", () => {
    const harness = setupDebugQueryHarness();
    const queryFile = path.join(harness.tempDir, "query.sql");
    fs.writeFileSync(queryFile, "SELECT 42;\n");

    const fileResult = spawnSync("bash", [scriptPath, "-f", queryFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
        TEST_OUTPUT_DIR: harness.outputDir,
      },
    });

    const fileArgs = fs.readFileSync(path.join(harness.outputDir, "args"), "utf8");
    const filePgOptions = fs.readFileSync(path.join(harness.outputDir, "pgoptions"), "utf8");

    expect(fileResult.status).toBe(0);
    expect(fileArgs).toContain("-f");
    expect(fileArgs).toContain(queryFile);
    expect(fileArgs).toContain("ON_ERROR_STOP=1");
    expect(filePgOptions).toContain("default_transaction_read_only=on");

    const stdinExecution = runDebugQuery([], { input: "SELECT now();\n" });

    expect(stdinExecution.result.status).toBe(0);
    expect(stdinExecution.argsOutput).toContain("-X");
    expect(stdinExecution.argsOutput).toContain("ON_ERROR_STOP=1");
    expect(stdinExecution.argsOutput).not.toContain("-c");
    expect(stdinExecution.argsOutput).not.toContain("-f");
    expect(stdinExecution.stdinOutput).toBe("SELECT now();\n");
    expect(stdinExecution.pgOptionsOutput).toContain("default_transaction_read_only=on");
  });
});
