import type { Sandbox } from "@vercel/sandbox";

export type { Sandbox };

export type SandboxConfig = {
  repoUrl: string;
  gitToken: string;
  baseBranch?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
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
