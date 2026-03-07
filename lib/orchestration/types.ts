export type { AgentType } from "@/lib/agents/types";

export type TaskStage =
  | "queued"
  | "starting"
  | "awaiting_approval"
  | "provisioning_sandbox"
  | "running_agent"
  | "collecting_results"
  | "validating"
  | "creating_pr"
  | "notifying"
  | "succeeded"
  | "failed"
  | "cancelled";

export type CodingTaskPayload = {
  mode: "new" | "continue";
  source: "slack" | "sentry" | "manual";
  repo: string;
  owner: string;
  baseBranch: string;
  title: string;
  prompt: string;
  agentType?: "claude" | "codex";

  // for continue mode
  branchName?: string;
  previousRunId?: string;

  slack?: {
    channelId: string;
    threadTs?: string;
    userId?: string;
  };

  sentry?: {
    issueId?: string;
    fingerprint?: string;
    permalink?: string;
    title?: string;
    level?: string;
  };
};

export type TaskStatusMetadata = {
  stage: TaskStage;
  progress: number;
  repo: string;
  owner: string;
  baseBranch: string;

  sandboxId?: string;
  agentType?: string;
  threadTs?: string;

  branchName?: string;
  commitSha?: string;
  prUrl?: string;

  summary?: string;
  error?: {
    message: string;
    code?: string;
  };
};
