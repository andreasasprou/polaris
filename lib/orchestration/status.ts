import { metadata } from "@trigger.dev/sdk";
import type { TaskStatusMetadata } from "./types";

export function getTaskStatus(): Partial<TaskStatusMetadata> {
  return (metadata.get("task") ?? {}) as Partial<TaskStatusMetadata>;
}

export function patchTaskStatus(patch: Partial<TaskStatusMetadata>) {
  metadata.set("task", {
    ...getTaskStatus(),
    ...patch,
  });
}
