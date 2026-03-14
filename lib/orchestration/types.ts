import type { AgentType } from "@/lib/sandbox-agent/types";
export type { AgentType };

export type TaskStage =
  | "queued"
  | "starting"
  | "provisioning_sandbox"
  | "running_agent"
  | "collecting_results"
  | "validating"
  | "creating_pr"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Automation payload — dispatched from automation trigger router. */
export type AutomationCodingTaskPayload = {
  source: "automation";
  orgId: string;
  automationId: string;
  automationRunId: string;
  triggerEvent: Record<string, unknown>;
};

export type CodingTaskPayload = AutomationCodingTaskPayload;

export type TaskStatusMetadata = {
  stage: TaskStage;
  progress: number;
  repo: string;
  owner: string;
  baseBranch: string;

  sandboxId?: string;
  agentType?: string;

  branchName?: string;
  commitSha?: string;
  prUrl?: string;

  summary?: string;
  error?: {
    message: string;
    code?: string;
  };
};
