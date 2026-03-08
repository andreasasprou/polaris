import type { SandboxAgentEvent } from "@/lib/sandbox-agent/SandboxAgentClient";

/** Messages sent from frontend/API into the interactive session task. */
export type SessionMessage =
  | { action: "prompt"; prompt: string }
  | { action: "stop" };

/** Output stream shape for tasks that forward agent events. */
export type EventStreamMap = {
  events: SandboxAgentEvent;
};
