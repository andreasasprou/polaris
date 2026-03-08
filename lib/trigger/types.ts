import type { SandboxAgentEvent } from "@/lib/sandbox-agent/SandboxAgentClient";

/** Messages sent from frontend/API into the interactive session task. */
export type SessionMessage =
  | { action: "prompt"; prompt: string }
  | { action: "stop" }
  | { action: "permission_reply"; permissionId: string; reply: string }
  | { action: "question_reply"; questionId: string; answers: string[][] }
  | { action: "question_reject"; questionId: string };

/** Output stream shape for tasks that forward agent events. */
export type EventStreamMap = {
  events: SandboxAgentEvent;
};
