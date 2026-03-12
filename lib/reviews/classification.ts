import { minimatch } from "minimatch";
import type { PRReviewConfig } from "./types";

export type FileClassification = "production" | "relaxed";

const DEFAULT_PRODUCTION = ["src/**", "lib/**", "app/**", "packages/**"];
const DEFAULT_RELAXED = [
  "test/**",
  "tests/**",
  "**/*.test.*",
  "**/*.spec.*",
  "docs/**",
  "*.md",
  ".github/**",
  "scripts/**",
];

/**
 * Classify changed files as production (full scrutiny) or relaxed (P2 cap).
 * Files not matching either pattern default to production.
 */
export function classifyFiles(
  files: string[],
  config: PRReviewConfig,
): Map<string, FileClassification> {
  const productionPatterns =
    config.fileClassification?.production ?? DEFAULT_PRODUCTION;
  const relaxedPatterns =
    config.fileClassification?.relaxed ?? DEFAULT_RELAXED;

  const result = new Map<string, FileClassification>();

  for (const file of files) {
    const isRelaxed = relaxedPatterns.some((p) => minimatch(file, p));
    const isProduction = productionPatterns.some((p) => minimatch(file, p));

    // Explicit production takes precedence over relaxed
    if (isProduction) {
      result.set(file, "production");
    } else if (isRelaxed) {
      result.set(file, "relaxed");
    } else {
      // Default: production
      result.set(file, "production");
    }
  }

  return result;
}

/**
 * Filter files to exclude ignored paths from the diff.
 */
export function filterIgnoredPaths(
  files: string[],
  ignorePaths: string[],
): string[] {
  if (!ignorePaths.length) return files;
  return files.filter(
    (f) => !ignorePaths.some((pattern) => minimatch(f, pattern)),
  );
}
