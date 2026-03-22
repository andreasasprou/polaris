import { z } from "zod";
import yaml from "js-yaml";
import type { Octokit } from "octokit";
import type { PRReviewConfig } from "./types";
import type { AgentType, ModelParams } from "@/lib/sandbox-agent/types";
import { fetchFileContent } from "./repo-content";

// ── Zod schema (YAML keys normalized to camelCase at parse boundary) ──

export const RepoReviewDefinitionSchema = z.object({
  name: z.string().min(1),
  instructions: z.string().optional(),
  filters: z
    .object({
      branches: z.array(z.string()).optional(),
      ignorePaths: z.array(z.string()).optional(),
      skipDrafts: z.boolean().optional(),
      skipBots: z.boolean().optional(),
      skipLabels: z.array(z.string()).optional(),
    })
    .optional(),
  fileClassification: z
    .object({
      production: z.array(z.string()),
      relaxed: z.array(z.string()),
    })
    .optional(),
});

export type RepoReviewDefinition = z.infer<typeof RepoReviewDefinitionSchema>;

// ── Discriminated result from config loading ──

export type RepoConfigResult =
  | { status: "found"; definition: RepoReviewDefinition; file: string }
  | { status: "not_found" }
  | { status: "invalid"; file: string; error: string }
  | { status: "multiple"; files: string[] }
  | { status: "error"; error: string };

// ── Merged result: YAML + connector defaults ──

export interface ResolvedReviewConfig {
  definition: RepoReviewDefinition;
  reviewConfig: PRReviewConfig;
  agentType: AgentType;
  model: string;
  modelParams: ModelParams;
  credentialRef: { secretId?: string; keyPoolId?: string };
}

// ── YAML key normalization ──

/**
 * Recursively convert kebab-case keys to camelCase.
 * "ignore-paths" → "ignorePaths"
 * "file-classification" → "fileClassification"
 */
export function normalizeKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(normalizeKeys);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([key, val]) => [
        key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
        normalizeKeys(val),
      ]),
    );
  }
  return obj;
}

// ── Config loading ──

const CONFIG_DIR = ".polaris/reviews";

/**
 * Fetch and parse .polaris/reviews/ from repo via GitHub Contents API.
 * Reads from the BASE BRANCH (event.baseRef), not the PR head.
 *
 * @param ref - Branch name (e.g. "main"), NOT a commit SHA.
 */
export async function loadRepoReviewConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<RepoConfigResult> {
  try {
    // 1. Fetch directory listing
    let dirData: unknown;
    try {
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: CONFIG_DIR,
        ref,
      });
      dirData = response.data;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status: number }).status === 404
      ) {
        return { status: "not_found" };
      }
      throw err;
    }

    // 2. Must be a directory (array)
    if (!Array.isArray(dirData)) {
      return {
        status: "invalid",
        file: CONFIG_DIR,
        error: `${CONFIG_DIR} must be a directory`,
      };
    }

    // 3. Filter for .yaml/.yml files
    const yamlFiles = (dirData as Array<{ name: string }>).filter((entry) => {
      const name = entry.name.toLowerCase();
      return name.endsWith(".yaml") || name.endsWith(".yml");
    });

    if (yamlFiles.length === 0) {
      return { status: "not_found" };
    }

    if (yamlFiles.length > 1) {
      return {
        status: "multiple",
        files: yamlFiles.map((f) => f.name),
      };
    }

    // 4. Fetch the single file
    const fileName = yamlFiles[0].name;
    const filePath = `${CONFIG_DIR}/${fileName}`;
    const content = await fetchFileContent(octokit, owner, repo, ref, filePath);

    if (!content) {
      return {
        status: "invalid",
        file: fileName,
        error: `Could not read ${filePath}`,
      };
    }

    // 5. Parse YAML
    let parsed: unknown;
    try {
      parsed = yaml.load(content);
    } catch (err) {
      return {
        status: "invalid",
        file: fileName,
        error: `Invalid YAML — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!parsed || typeof parsed !== "object") {
      return {
        status: "invalid",
        file: fileName,
        error: "YAML file must contain an object",
      };
    }

    // 6. Normalize keys (kebab → camelCase)
    const normalized = normalizeKeys(parsed);

    // 7. Validate against schema
    const result = RepoReviewDefinitionSchema.safeParse(normalized);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return {
        status: "invalid",
        file: fileName,
        error: `Validation failed — ${issues}`,
      };
    }

    return { status: "found", definition: result.data, file: fileName };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Merge with connector ──

/**
 * Merge a YAML definition with connector automation defaults.
 * Returns a shape that includes a PRReviewConfig for existing call sites.
 */
export function mergeWithConnector(
  definition: RepoReviewDefinition,
  automation: {
    prReviewConfig: PRReviewConfig | null;
    agentType: string | null;
    model: string | null;
    modelParams: ModelParams | null;
    agentSecretId: string | null;
    keyPoolId: string | null;
  },
): ResolvedReviewConfig {
  const connector = automation.prReviewConfig ?? {};

  const reviewConfig: PRReviewConfig = { ...connector };

  // instructions → replaces customPrompt (even if empty string — explicit clear)
  if (definition.instructions !== undefined) {
    reviewConfig.customPrompt = definition.instructions;
  }

  // filters — each present field replaces; omitted inherits
  if (definition.filters) {
    if (definition.filters.branches !== undefined) {
      reviewConfig.branchFilter = definition.filters.branches;
    }
    if (definition.filters.ignorePaths !== undefined) {
      reviewConfig.ignorePaths = definition.filters.ignorePaths;
    }
    if (definition.filters.skipDrafts !== undefined) {
      reviewConfig.skipDrafts = definition.filters.skipDrafts;
    }
    if (definition.filters.skipBots !== undefined) {
      reviewConfig.skipBots = definition.filters.skipBots;
    }
    if (definition.filters.skipLabels !== undefined) {
      reviewConfig.skipLabels = definition.filters.skipLabels;
    }
  }

  // fileClassification — replaces entirely if present
  if (definition.fileClassification) {
    reviewConfig.fileClassification = definition.fileClassification;
  }

  return {
    definition,
    reviewConfig,
    agentType: (automation.agentType ?? "claude") as AgentType,
    model: automation.model ?? "",
    modelParams: automation.modelParams ?? {},
    credentialRef: {
      secretId: automation.agentSecretId ?? undefined,
      keyPoolId: automation.keyPoolId ?? undefined,
    },
  };
}

// ── Error formatting ──

export function formatConfigError(
  result: Extract<
    RepoConfigResult,
    { status: "invalid" | "multiple" | "error" }
  >,
): string {
  switch (result.status) {
    case "invalid":
      return `Review config error: .polaris/reviews/${result.file} — ${result.error}`;
    case "multiple":
      return `Review config error: Multiple review definitions found in .polaris/reviews/ (${result.files.join(", ")}). Only one is supported in the current version.`;
    case "error":
      return `Review config error: Failed to load .polaris/reviews/ — ${result.error}`;
  }
}
