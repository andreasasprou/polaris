/**
 * Centralized agent capabilities registry.
 *
 * All per-agent knowledge (valid models, modes, thought levels, effort mechanisms)
 * lives here. Call sites express semantic intent ("autonomous", "read-only") and the
 * resolver maps it to the correct agent-native values — no agent-specific branching
 * anywhere else in the codebase.
 */

import type { AgentType } from "./types";

// ── Semantic intents ──

export type ModeIntent = "autonomous" | "read-only" | "interactive";

// ── Profile shape ──

export type ProviderType = "anthropic" | "openai";

type AgentProfile = {
  label: string;
  enabled: boolean;
  compatibleProviders: readonly ProviderType[];
  models: readonly string[];
  modes: readonly string[];
  thoughtLevels: readonly string[] | null;
  defaultMode: Record<ModeIntent, string | null>;
  /** Tools whitelisted when running with read-only intent (dontAsk + allowedTools). */
  readOnlyAllowedTools?: readonly string[];
  effortMechanism: "sdk-thought-level" | "filesystem-settings" | null;
  filesystemConfigPath?: (cwd: string) => string;
};

// ── Per-agent profiles ──

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "Bash"] as const;

const PROFILES: Record<AgentType, AgentProfile> = {
  claude: {
    label: "Claude Code",
    enabled: true,
    compatibleProviders: ["anthropic"],
    models: ["default", "sonnet", "opus", "haiku"],
    modes: ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"],
    thoughtLevels: null,
    defaultMode: {
      autonomous: "bypassPermissions",
      "read-only": "dontAsk",
      interactive: "default",
    },
    readOnlyAllowedTools: READ_ONLY_TOOLS,
    effortMechanism: "filesystem-settings",
    filesystemConfigPath: (cwd) => `${cwd}/.claude/settings.json`,
  },
  codex: {
    label: "Codex",
    enabled: true,
    compatibleProviders: ["openai"],
    models: [
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.1-codex-max",
      "gpt-5.2",
      "gpt-5.1-codex-mini",
    ],
    modes: ["read-only", "auto", "full-access"],
    thoughtLevels: ["low", "medium", "high", "xhigh"],
    defaultMode: {
      autonomous: "full-access",
      "read-only": "read-only",
      interactive: "auto",
    },
    effortMechanism: "sdk-thought-level",
  },
  opencode: {
    label: "OpenCode",
    enabled: false,
    compatibleProviders: ["anthropic", "openai"],
    models: [],
    modes: ["build", "plan"],
    thoughtLevels: null,
    defaultMode: {
      autonomous: "build",
      "read-only": "plan",
      interactive: "build",
    },
    effortMechanism: null,
  },
  amp: {
    label: "Amp",
    enabled: false,
    compatibleProviders: ["anthropic"],
    models: [],
    modes: ["default", "bypass"],
    thoughtLevels: null,
    defaultMode: {
      autonomous: "bypass",
      "read-only": null,
      interactive: "default",
    },
    effortMechanism: null,
  },
};

// ── Resolver ──

export type AgentSessionIntent = {
  agentType: AgentType;
  modeIntent: ModeIntent;
  modeOverride?: string;
  model?: string;
  effortLevel?: string;
};

export type ResolvedAgentConfig = {
  agent: AgentType;
  model: string | undefined;
  mode: string;
  thoughtLevel: string | undefined;
  filesystemConfig: { path: string; content: Record<string, unknown> } | null;
};

export function resolveAgentConfig(
  intent: AgentSessionIntent,
): ResolvedAgentConfig {
  const profile = PROFILES[intent.agentType];

  // ── Mode ──
  let mode: string;
  if (intent.modeOverride) {
    if (!profile.modes.includes(intent.modeOverride)) {
      throw new Error(
        `Invalid mode "${intent.modeOverride}" for agent "${intent.agentType}". ` +
          `Valid modes: ${profile.modes.join(", ")}`,
      );
    }
    mode = intent.modeOverride;
  } else {
    const resolved = profile.defaultMode[intent.modeIntent];
    if (resolved === null) {
      throw new Error(
        `Agent "${intent.agentType}" does not support "${intent.modeIntent}" mode intent`,
      );
    }
    mode = resolved;
  }

  // ── Model ──
  if (
    intent.model &&
    profile.models.length > 0 &&
    !profile.models.includes(intent.model)
  ) {
    throw new Error(
      `Invalid model "${intent.model}" for agent "${intent.agentType}". ` +
        `Valid models: ${profile.models.join(", ")}`,
    );
  }

  // ── Effort / Thought level ──
  let thoughtLevel: string | undefined;
  let filesystemConfig: { path: string; content: Record<string, unknown> } | null =
    null;

  if (intent.effortLevel) {
    if (profile.effortMechanism === "sdk-thought-level") {
      if (
        profile.thoughtLevels &&
        !profile.thoughtLevels.includes(intent.effortLevel)
      ) {
        throw new Error(
          `Invalid effort level "${intent.effortLevel}" for agent "${intent.agentType}". ` +
            `Valid levels: ${profile.thoughtLevels.join(", ")}`,
        );
      }
      thoughtLevel = intent.effortLevel;
    } else if (profile.effortMechanism === "filesystem-settings") {
      filesystemConfig = buildFilesystemConfig(profile, intent, {});
    }
    // null mechanism: silently ignore
  }

  // ── Read-only intent: merge permission settings into filesystemConfig ──
  if (
    intent.modeIntent === "read-only" &&
    profile.readOnlyAllowedTools &&
    profile.filesystemConfigPath
  ) {
    const permissions = {
      defaultMode: "dontAsk" as const,
      allow: [...profile.readOnlyAllowedTools],
    };
    if (filesystemConfig) {
      // Already have filesystem config (effort level) — merge permissions in
      filesystemConfig.content.permissions = permissions;
    } else {
      filesystemConfig = buildFilesystemConfig(profile, intent, { permissions });
    }
  }

  // ── Effort level in filesystem config (may not have been set above if no read-only) ──
  if (
    intent.effortLevel &&
    profile.effortMechanism === "filesystem-settings" &&
    !filesystemConfig
  ) {
    filesystemConfig = buildFilesystemConfig(profile, intent, {});
  }

  return {
    agent: intent.agentType,
    model: intent.model,
    mode,
    thoughtLevel,
    filesystemConfig,
  };
}

function buildFilesystemConfig(
  profile: AgentProfile,
  intent: AgentSessionIntent,
  extra: Record<string, unknown>,
): { path: string; content: Record<string, unknown> } | null {
  if (!profile.filesystemConfigPath) return null;
  const content: Record<string, unknown> = { ...extra };
  if (intent.effortLevel && profile.effortMechanism === "filesystem-settings") {
    content.effortLevel = intent.effortLevel;
  }
  return {
    path: profile.filesystemConfigPath("__CWD__"), // placeholder, resolved at call site
    content,
  };
}

// ── Filesystem config writer ──

export async function applyFilesystemConfig(
  runShell: (cmd: string, opts?: { cwd?: string }) => Promise<{ exitCode: number; stderr: string }>,
  cwd: string,
  config: { path: string; content: Record<string, unknown> },
): Promise<void> {
  const resolvedPath = config.path.replace("__CWD__", cwd);
  const dir = resolvedPath.substring(0, resolvedPath.lastIndexOf("/"));
  await runShell(`mkdir -p ${dir}`, { cwd });
  const json = JSON.stringify(config.content, null, 2);
  // Use heredoc to avoid shell escaping issues
  await runShell(`cat > ${resolvedPath} << 'POLARIS_EOF'\n${json}\nPOLARIS_EOF`, { cwd });
}

// ── UI helpers ──

export function getProfile(agentType: AgentType): AgentProfile {
  return PROFILES[agentType];
}

export function getModels(agentType: AgentType): readonly string[] {
  return PROFILES[agentType].models;
}

export function getModes(agentType: AgentType): readonly string[] {
  return PROFILES[agentType].modes;
}

export function getThoughtLevels(agentType: AgentType): readonly string[] | null {
  return PROFILES[agentType].thoughtLevels;
}

export function getCompatibleProviders(agentType: AgentType): readonly ProviderType[] {
  return PROFILES[agentType].compatibleProviders;
}

/** Enabled agents for UI dropdowns: `[{ value: "claude", label: "Claude Code" }, ...]` */
export function getEnabledAgents(): { value: AgentType; label: string }[] {
  return (Object.entries(PROFILES) as [AgentType, AgentProfile][])
    .filter(([, p]) => p.enabled)
    .map(([value, p]) => ({ value, label: p.label }));
}

/** Enabled agent type keys — for non-UI code (snapshots, validation, etc.) */
export function getEnabledAgentTypes(): AgentType[] {
  return getEnabledAgents().map((a) => a.value);
}
