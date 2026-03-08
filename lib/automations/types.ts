export type TriggerType = "github" | "slack" | "schedule" | "webhook" | "sentry";

export type GitHubTriggerConfig = {
  events: string[]; // e.g. ["pull_request.opened", "push"]
  branches?: string[]; // e.g. ["main"]
};

export type SlackTriggerConfig = {
  slackWorkspaceId: string;
  channelId: string;
  keywords?: string[];
};

export type ScheduleTriggerConfig = {
  cron: string;
  timezone?: string;
};

export type WebhookTriggerConfig = Record<string, never>;

export type SentryTriggerConfig = {
  projectSlugs: string[];
  levels?: string[];
};

export type TriggerConfig =
  | GitHubTriggerConfig
  | SlackTriggerConfig
  | ScheduleTriggerConfig
  | WebhookTriggerConfig
  | SentryTriggerConfig;

export type AgentType = "claude" | "codex";
export type ApprovalMode = "none" | "slack";
export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type NotifyEvent = "success" | "failure" | "approval_required";
