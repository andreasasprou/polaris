import type { NormalizedPrReviewEvent, ManualReviewCommand } from "./types";
import { parseManualReviewCommand } from "./manual-trigger";

/**
 * Normalize a raw GitHub webhook payload into our canonical PR review event.
 * Returns null if the event is not relevant to PR review.
 */
export function normalizePREvent(
  eventType: string,
  action: string | undefined,
  payload: Record<string, unknown>,
  installationId: number,
): NormalizedPrReviewEvent | null {
  if (eventType === "pull_request") {
    return normalizePullRequestEvent(action, payload, installationId);
  }

  if (eventType === "issue_comment") {
    return normalizeIssueCommentEvent(action, payload, installationId);
  }

  return null;
}

function normalizePullRequestEvent(
  action: string | undefined,
  payload: Record<string, unknown>,
  installationId: number,
): NormalizedPrReviewEvent | null {
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (!pr) return null;

  const repo = payload.repository as Record<string, unknown>;
  const sender = payload.sender as Record<string, unknown>;
  const head = pr.head as Record<string, unknown>;
  const base = pr.base as Record<string, unknown>;

  const labels = ((pr.labels as Array<Record<string, unknown>>) ?? []).map(
    (l) => l.name as string,
  );

  return {
    eventType: "pull_request",
    action: action ?? "unknown",
    installationId,
    owner: (repo.owner as Record<string, unknown>).login as string,
    repo: repo.name as string,
    prNumber: pr.number as number,
    prUrl: pr.html_url as string,
    isOpen: pr.state === "open",
    isDraft: (pr.draft as boolean) ?? false,
    senderLogin: sender.login as string,
    senderType: sender.type as string,
    senderIsBot: sender.type === "Bot",
    labels,
    baseRef: base.ref as string,
    baseSha: base.sha as string,
    headRef: head.ref as string,
    headSha: head.sha as string,
    title: pr.title as string,
    body: (pr.body as string) ?? null,
  };
}

function normalizeIssueCommentEvent(
  action: string | undefined,
  payload: Record<string, unknown>,
  installationId: number,
): NormalizedPrReviewEvent | null {
  if (action !== "created") return null;

  const issue = payload.issue as Record<string, unknown>;
  if (!issue) return null;

  // Only PR comments (issues with pull_request key)
  const prRef = issue.pull_request as Record<string, unknown> | undefined;
  if (!prRef) return null;

  const comment = payload.comment as Record<string, unknown>;
  const commentBody = (comment?.body as string) ?? "";

  // Only react to /review commands
  const manualCommand = parseManualReviewCommand(commentBody);
  if (!manualCommand) return null;

  const repo = payload.repository as Record<string, unknown>;
  const sender = payload.sender as Record<string, unknown>;

  const labels = ((issue.labels as Array<Record<string, unknown>>) ?? []).map(
    (l) => l.name as string,
  );

  return {
    eventType: "issue_comment",
    action: "created",
    installationId,
    owner: (repo.owner as Record<string, unknown>).login as string,
    repo: repo.name as string,
    prNumber: issue.number as number,
    prUrl: issue.html_url as string,
    isOpen: issue.state === "open",
    isDraft: false, // Can't determine from issue_comment — will need PR fetch
    senderLogin: sender.login as string,
    senderType: sender.type as string,
    senderIsBot: sender.type === "Bot",
    labels,
    // These need to be resolved from the PR API — set empty for now
    baseRef: "",
    baseSha: "",
    headRef: "",
    headSha: "",
    title: issue.title as string,
    body: (issue.body as string) ?? null,
    commentId: String(comment.id),
    commentBody,
    manualCommand,
  };
}
