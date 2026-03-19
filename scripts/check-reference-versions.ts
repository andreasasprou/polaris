/**
 * Checks that reference documentation version locks match installed package versions.
 *
 * For each .txt file in docs/references/:
 * 1. Parses the "# Locked version:" line
 * 2. Reads the installed version from node_modules/<package>/package.json
 * 3. Fails if they differ
 *
 * Usage: tsx scripts/check-reference-versions.ts
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { createRequire } from "module";

const PROJECT_ROOT = join(import.meta.dirname!, "..");
const REFERENCES_DIR = join(PROJECT_ROOT, "docs", "references");

// Use createRequire to resolve packages — works with pnpm, hoisted node_modules,
// and worktrees that share node_modules with the main project.
const require = createRequire(join(PROJECT_ROOT, "package.json"));

/** Known mapping from reference doc filename to npm package name. */
const PACKAGE_MAP: Record<string, string> = {
  "vercel-sandbox-llms.txt": "@vercel/sandbox",
  "sandbox-agent-llms.txt": "sandbox-agent",
  "acp-http-client-llms.txt": "acp-http-client",
};

type CheckResult = {
  file: string;
  packageName: string;
  lockedVersion: string;
  installedVersion: string;
  match: boolean;
};

function parseLockedVersion(filePath: string): { version: string; packageName: string | null } | null {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").slice(0, 10);

  let version: string | null = null;

  for (const line of lines) {
    const versionMatch = line.match(/^#\s*Locked version:\s*(.+)$/);
    if (versionMatch) {
      version = versionMatch[1].trim();
    }
  }

  if (!version) return null;

  return { version, packageName: null };
}

function getInstalledVersion(packageName: string): string | null {
  // Strategy 1: Use Node module resolution via createRequire.
  // Works with pnpm, hoisted node_modules, and standard layouts.
  try {
    const entryPoint = require.resolve(packageName);
    let dir = dirname(entryPoint);
    while (dir !== dirname(dir)) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkgJson = JSON.parse(readFileSync(candidate, "utf-8"));
        if (pkgJson.name === packageName) {
          return pkgJson.version;
        }
      }
      dir = dirname(dir);
    }
  } catch {
    // Fall through to strategy 2
  }

  // Strategy 2: Direct node_modules/<package>/package.json lookup.
  // Fallback for environments where require.resolve fails (e.g. missing node_modules symlink).
  try {
    const directPath = join(PROJECT_ROOT, "node_modules", packageName, "package.json");
    if (existsSync(directPath)) {
      const pkgJson = JSON.parse(readFileSync(directPath, "utf-8"));
      return pkgJson.version;
    }
  } catch {
    // Fall through
  }

  return null;
}

function main() {
  let files: string[];
  try {
    files = readdirSync(REFERENCES_DIR).filter((f) => f.endsWith(".txt"));
  } catch {
    console.log("No docs/references/ directory found — skipping check.");
    process.exit(0);
  }

  if (files.length === 0) {
    console.log("No reference docs found in docs/references/ — skipping check.");
    process.exit(0);
  }

  const results: CheckResult[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const filePath = join(REFERENCES_DIR, file);
    const parsed = parseLockedVersion(filePath);

    if (!parsed) {
      errors.push(`${file}: Missing "# Locked version:" in first 10 lines`);
      continue;
    }

    const packageName = PACKAGE_MAP[file];
    if (!packageName) {
      errors.push(`${file}: No package mapping defined in PACKAGE_MAP — add it to scripts/check-reference-versions.ts`);
      continue;
    }

    const installedVersion = getInstalledVersion(packageName);
    if (!installedVersion) {
      errors.push(`${file}: Package "${packageName}" not found in node_modules`);
      continue;
    }

    const match = parsed.version === installedVersion;
    results.push({
      file,
      packageName,
      lockedVersion: parsed.version,
      installedVersion,
      match,
    });
  }

  // Print results
  console.log("Reference doc version check:");
  console.log("─".repeat(60));

  for (const r of results) {
    const status = r.match ? "OK" : "MISMATCH";
    const icon = r.match ? "  " : "! ";
    console.log(`${icon}${r.file}`);
    console.log(`   Package: ${r.packageName}`);
    console.log(`   Locked:  ${r.lockedVersion}`);
    console.log(`   Installed: ${r.installedVersion}`);
    console.log(`   Status: ${status}`);
    console.log();
  }

  for (const err of errors) {
    console.log(`! ${err}`);
  }

  const mismatches = results.filter((r) => !r.match);
  if (mismatches.length > 0 || errors.length > 0) {
    console.log("─".repeat(60));
    if (mismatches.length > 0) {
      console.error(
        `FAIL: ${mismatches.length} reference doc(s) have stale version locks.`
      );
      for (const m of mismatches) {
        console.error(
          `  ${m.file}: locked=${m.lockedVersion} installed=${m.installedVersion}`
        );
      }
      console.error(
        "Update the docs to match installed versions, or update the packages to match the docs."
      );
    }
    process.exit(1);
  }

  console.log("─".repeat(60));
  console.log(`All ${results.length} reference doc(s) match installed versions.`);
}

main();
