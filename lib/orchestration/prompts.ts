import type { CodingTaskPayload } from "./types";

export function buildAgentPrompt(
  input: CodingTaskPayload & { branchName: string },
) {
  const sentryBlock = input.sentry
    ? [
        "SENTRY CONTEXT:",
        `- Issue ID: ${input.sentry.issueId ?? "unknown"}`,
        `- Title: ${input.sentry.title ?? "unknown"}`,
        `- Level: ${input.sentry.level ?? "unknown"}`,
        `- Fingerprint: ${input.sentry.fingerprint ?? "unknown"}`,
        `- Link: ${input.sentry.permalink ?? "unknown"}`,
      ].join("\n")
    : "";

  return [
    `Task: ${input.title}`,
    "",
    input.prompt,
    "",
    sentryBlock,
    "",
    "REQUIREMENTS:",
    `1. You are on branch ${input.branchName}. Make changes on this branch.`,
    "2. Make the smallest safe fix.",
    "3. Run the most relevant checks available in the repo.",
    "4. Do NOT commit or push — the orchestrator handles git operations.",
    "5. Do not open a PR yourself.",
    "",
    "OUTPUT STYLE:",
    "- Be concise in intermediate messages.",
    "- Prefer concrete repo actions over general commentary.",
  ]
    .filter(Boolean)
    .join("\n");
}
