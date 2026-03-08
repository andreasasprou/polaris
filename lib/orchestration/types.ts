import type { AgentType } from "@/lib/sandbox-agent/types";
export type { AgentType };

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

/** Legacy v2 payload — direct trigger from Slack/Sentry/manual. */
export type LegacyCodingTaskPayload = {
  mode: "new" | "continue";
  source: "slack" | "sentry" | "manual";
  repo: string;
  owner: string;
  baseBranch: string;
  title: string;
  prompt: string;
  agentType?: AgentType;

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

/** v3 payload — dispatched from automation trigger router. */
export type AutomationCodingTaskPayload = {
  source: "automation";
  orgId: string;
  automationId: string;
  automationRunId: string;
  triggerEvent: Record<string, unknown>;
};

export type CodingTaskPayload =
  | LegacyCodingTaskPayload
  | AutomationCodingTaskPayload;

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
