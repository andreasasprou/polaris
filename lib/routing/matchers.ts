import type { GitHubTriggerConfig } from "@/lib/automations/types";

/**
 * Check if a GitHub webhook event matches an automation's trigger config.
 */
export function matchesGitHubTrigger(
  eventType: string,
  action: string | undefined,
  ref: string | undefined,
  config: GitHubTriggerConfig,
): boolean {
  // Build the full event string (e.g. "pull_request.opened")
  const fullEvent = action ? `${eventType}.${action}` : eventType;

  // Check if the event matches any configured events
  const eventMatch = config.events.some((e) => {
    // Exact match: "push" === "push" or "pull_request.opened" === "pull_request.opened"
    if (e === fullEvent) return true;
    // Prefix match: "pull_request" matches "pull_request.opened"
    if (!e.includes(".") && fullEvent.startsWith(`${e}.`)) return true;
    return false;
  });

  if (eventMatch) {
    // Check branch filter if specified
    if (config.branches && config.branches.length > 0 && ref) {
      const branch = ref.replace("refs/heads/", "");
      return config.branches.includes(branch);
    }
    return true;
  }

  // For continuous automations that listen to pull_request events,
  // also match issue_comment.created (for /review commands on PRs).
  // The router will filter to actual /review commands downstream.
  if (eventType === "issue_comment" && action === "created") {
    const hasPrEvents = config.events.some(
      (e) => e === "pull_request" || e.startsWith("pull_request."),
    );
    if (hasPrEvents) return true;
  }

  return false;
}
