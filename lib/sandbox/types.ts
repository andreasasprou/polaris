import type { Sandbox } from "@vercel/sandbox";

export type { Sandbox };

/** How the sandbox filesystem is initialized. */
export type SandboxSource =
  | { type: "git" }
  | { type: "snapshot"; snapshotId: string };

export type SandboxConfig = {
  source: SandboxSource;
  repoUrl: string;
  gitToken: string;
  baseBranch?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  ports?: number[];
  observability?: {
    axiomIngestUrl?: string;
    axiomToken?: string;
  };
};

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GitChanges = {
  changed: boolean;
  diffSummary: string;
  filesChanged: string[];
};

export type GitCommitResult = {
  commitSha: string;
  pushed: boolean;
  pushStderr?: string;
};

export type SandboxUsageSummary = {
  sandboxId: string;
  status: string;
  createdAt?: string;
  stoppedAt: string;
  timeoutMs?: number;
  activeCpuUsageMs?: number;
  networkUsage?: { ingress: number; egress: number };
  ageMs?: number;
};
