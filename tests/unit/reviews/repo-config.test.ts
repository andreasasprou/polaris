import { describe, it, expect } from "vitest";
import {
  RepoReviewDefinitionSchema,
  normalizeKeys,
  mergeWithConnector,
  formatConfigError,
  type RepoReviewDefinition,
  type RepoConfigResult,
} from "@/lib/reviews/repo-config";
import type { PRReviewConfig } from "@/lib/reviews/types";

// ── normalizeKeys ──

describe("normalizeKeys", () => {
  it("converts kebab-case to camelCase", () => {
    expect(normalizeKeys({ "ignore-paths": ["*.lock"] })).toEqual({
      ignorePaths: ["*.lock"],
    });
  });

  it("converts nested kebab-case keys", () => {
    const input = {
      "file-classification": {
        production: ["src/**"],
        relaxed: ["tests/**"],
      },
      filters: {
        "skip-drafts": true,
        "skip-bots": false,
        "skip-labels": ["no-review"],
        "ignore-paths": ["dist/**"],
      },
    };
    expect(normalizeKeys(input)).toEqual({
      fileClassification: {
        production: ["src/**"],
        relaxed: ["tests/**"],
      },
      filters: {
        skipDrafts: true,
        skipBots: false,
        skipLabels: ["no-review"],
        ignorePaths: ["dist/**"],
      },
    });
  });

  it("leaves camelCase keys unchanged", () => {
    expect(normalizeKeys({ skipDrafts: true })).toEqual({ skipDrafts: true });
  });

  it("handles arrays", () => {
    expect(normalizeKeys([{ "my-key": 1 }, { "other-key": 2 }])).toEqual([
      { myKey: 1 },
      { otherKey: 2 },
    ]);
  });

  it("passes through primitives", () => {
    expect(normalizeKeys("hello")).toBe("hello");
    expect(normalizeKeys(42)).toBe(42);
    expect(normalizeKeys(true)).toBe(true);
    expect(normalizeKeys(null)).toBe(null);
  });

  it("handles empty object", () => {
    expect(normalizeKeys({})).toEqual({});
  });

  it("handles multiple hyphens in key", () => {
    expect(normalizeKeys({ "my-long-key-name": "val" })).toEqual({
      myLongKeyName: "val",
    });
  });
});

// ── RepoReviewDefinitionSchema ──

describe("RepoReviewDefinitionSchema", () => {
  it("parses a minimal valid definition", () => {
    const result = RepoReviewDefinitionSchema.safeParse({
      name: "Code Review",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Code Review");
      expect(result.data.instructions).toBeUndefined();
      expect(result.data.filters).toBeUndefined();
      expect(result.data.fileClassification).toBeUndefined();
    }
  });

  it("parses a full definition", () => {
    const result = RepoReviewDefinitionSchema.safeParse({
      name: "Security Review",
      instructions: "Focus on auth and injection.\n",
      filters: {
        branches: ["main"],
        ignorePaths: ["*.lock", "dist/**"],
        skipDrafts: true,
        skipBots: false,
        skipLabels: ["no-review"],
      },
      fileClassification: {
        production: ["src/**", "lib/**"],
        relaxed: ["tests/**", "docs/**"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instructions).toBe("Focus on auth and injection.\n");
      expect(result.data.filters?.skipBots).toBe(false);
      expect(result.data.fileClassification?.production).toEqual([
        "src/**",
        "lib/**",
      ]);
    }
  });

  it("rejects empty name", () => {
    const result = RepoReviewDefinitionSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing name", () => {
    const result = RepoReviewDefinitionSchema.safeParse({
      instructions: "something",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid filter types", () => {
    const result = RepoReviewDefinitionSchema.safeParse({
      name: "Test",
      filters: { skipDrafts: "yes" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional empty instructions", () => {
    const result = RepoReviewDefinitionSchema.safeParse({
      name: "Test",
      instructions: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instructions).toBe("");
    }
  });
});

// ── mergeWithConnector ──

describe("mergeWithConnector", () => {
  const baseAutomation = {
    prReviewConfig: {
      customPrompt: "Old UI prompt...",
      branchFilter: ["main"],
      ignorePaths: ["*.lock"],
      skipDrafts: true,
      skipBots: true,
      skipLabels: ["no-review"],
      fileClassification: {
        production: ["src/**"],
        relaxed: ["tests/**"],
      },
    } as PRReviewConfig,
    agentType: "codex",
    model: "gpt-5.4",
    modelParams: { effortLevel: "xhigh" as const },
    agentSecretId: "secret-1",
    keyPoolId: null,
  };

  it("replaces customPrompt when instructions present", () => {
    const def: RepoReviewDefinition = {
      name: "Security Review",
      instructions: "Focus on auth.\n",
    };
    const result = mergeWithConnector(def, baseAutomation);
    expect(result.reviewConfig.customPrompt).toBe("Focus on auth.\n");
  });

  it("clears customPrompt when instructions is empty string", () => {
    const def: RepoReviewDefinition = {
      name: "Minimal",
      instructions: "",
    };
    const result = mergeWithConnector(def, baseAutomation);
    expect(result.reviewConfig.customPrompt).toBe("");
  });

  it("inherits customPrompt when instructions omitted", () => {
    const def: RepoReviewDefinition = { name: "Default" };
    const result = mergeWithConnector(def, baseAutomation);
    expect(result.reviewConfig.customPrompt).toBe("Old UI prompt...");
  });

  it("replaces individual filter fields (YAML wins)", () => {
    const def: RepoReviewDefinition = {
      name: "Test",
      filters: { skipBots: false },
    };
    const result = mergeWithConnector(def, baseAutomation);
    // skipBots replaced by YAML
    expect(result.reviewConfig.skipBots).toBe(false);
    // Other filters inherited from connector
    expect(result.reviewConfig.branchFilter).toEqual(["main"]);
    expect(result.reviewConfig.ignorePaths).toEqual(["*.lock"]);
    expect(result.reviewConfig.skipDrafts).toBe(true);
    expect(result.reviewConfig.skipLabels).toEqual(["no-review"]);
  });

  it("replaces fileClassification entirely when present", () => {
    const def: RepoReviewDefinition = {
      name: "Test",
      fileClassification: {
        production: ["app/**"],
        relaxed: ["docs/**"],
      },
    };
    const result = mergeWithConnector(def, baseAutomation);
    expect(result.reviewConfig.fileClassification).toEqual({
      production: ["app/**"],
      relaxed: ["docs/**"],
    });
  });

  it("inherits fileClassification when omitted", () => {
    const def: RepoReviewDefinition = { name: "Test" };
    const result = mergeWithConnector(def, baseAutomation);
    expect(result.reviewConfig.fileClassification).toEqual({
      production: ["src/**"],
      relaxed: ["tests/**"],
    });
  });

  it("preserves runtime config from connector", () => {
    const def: RepoReviewDefinition = { name: "Test" };
    const result = mergeWithConnector(def, baseAutomation);
    expect(result.agentType).toBe("codex");
    expect(result.model).toBe("gpt-5.4");
    expect(result.modelParams).toEqual({ effortLevel: "xhigh" });
    expect(result.credentialRef).toEqual({
      secretId: "secret-1",
      keyPoolId: undefined,
    });
  });

  it("handles null connector config gracefully", () => {
    const def: RepoReviewDefinition = {
      name: "Test",
      instructions: "New prompt",
    };
    const result = mergeWithConnector(def, {
      prReviewConfig: null,
      agentType: null,
      model: null,
      modelParams: null,
      agentSecretId: null,
      keyPoolId: null,
    });
    expect(result.reviewConfig.customPrompt).toBe("New prompt");
    expect(result.agentType).toBe("claude");
    expect(result.model).toBe("");
  });

  it("matches the exec plan merge example exactly", () => {
    const def: RepoReviewDefinition = {
      name: "Security Review",
      instructions: "Focus on auth, injection, and secret exposure.\n",
      filters: { skipBots: false },
    };
    const automation = {
      prReviewConfig: {
        customPrompt: "Old UI prompt...",
        branchFilter: ["main"],
        ignorePaths: ["*.lock"],
        skipDrafts: true,
        skipBots: true,
        skipLabels: ["no-review"],
        fileClassification: {
          production: ["src/**"],
          relaxed: ["tests/**"],
        },
      } as PRReviewConfig,
      agentType: "codex",
      model: "gpt-5.4",
      modelParams: null,
      agentSecretId: null,
      keyPoolId: null,
    };
    const result = mergeWithConnector(def, automation);

    expect(result.reviewConfig).toEqual({
      customPrompt: "Focus on auth, injection, and secret exposure.\n",
      branchFilter: ["main"],
      ignorePaths: ["*.lock"],
      skipDrafts: true,
      skipBots: false,
      skipLabels: ["no-review"],
      fileClassification: {
        production: ["src/**"],
        relaxed: ["tests/**"],
      },
    });
  });
});

// ── formatConfigError ──

describe("formatConfigError", () => {
  it("formats invalid result", () => {
    const result: RepoConfigResult = {
      status: "invalid",
      file: "default.yaml",
      error: "unexpected token at line 5",
    };
    expect(formatConfigError(result as Extract<RepoConfigResult, { status: "invalid" }>)).toBe(
      "Review config error: .polaris/reviews/default.yaml — unexpected token at line 5",
    );
  });

  it("formats multiple result", () => {
    const result: RepoConfigResult = {
      status: "multiple",
      files: ["default.yaml", "security.yaml"],
    };
    expect(formatConfigError(result as Extract<RepoConfigResult, { status: "multiple" }>)).toBe(
      "Review config error: Multiple review definitions found in .polaris/reviews/ (default.yaml, security.yaml). Only one is supported in the current version.",
    );
  });

  it("formats error result", () => {
    const result: RepoConfigResult = {
      status: "error",
      error: "GitHub API rate limit exceeded",
    };
    expect(formatConfigError(result as Extract<RepoConfigResult, { status: "error" }>)).toBe(
      "Review config error: Failed to load .polaris/reviews/ — GitHub API rate limit exceeded",
    );
  });
});
