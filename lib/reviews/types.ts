import { z } from "zod";

// ── Automation mode ──

export type AutomationMode = "oneshot" | "continuous";

// ── PR Review configuration (stored as JSONB on automations table) ──

export interface PRReviewConfig {
  /** Override model for this automation */
  model?: string;
  /** Agent-specific model parameters (e.g., effortLevel) */
  modelParams?: import("@/lib/sandbox-agent/types").ModelParams;
  /** Custom review instructions appended to the system prompt */
  customPrompt?: string;

  /** Only review PRs targeting these branches (e.g., ["main", "develop"]) */
  branchFilter?: string[];
  /** Only trigger when changes touch these paths (glob patterns) */
  pathFilter?: string[];
  /** Exclude these paths from the diff sent to the agent */
  ignorePaths?: string[];

  /** Skip draft PRs */
  skipDrafts?: boolean;
  /** Skip PRs authored by bots */
  skipBots?: boolean;
  /** Skip PRs with any of these labels */
  skipLabels?: string[];

  /** What to do when a push arrives mid-review */
  onConcurrentPush?: "queue" | "cancel";

  /** File classification rules for severity calibration */
  fileClassification?: {
    /** Glob patterns for full-scrutiny files (default: src/**, lib/**, app/**) */
    production: string[];
    /** Glob patterns for relaxed files — cap non-security at P2 */
    relaxed: string[];
  };

  /** Max bytes of diff to include in prompt (default 200_000) */
  maxPromptDiffBytes?: number;
  /** Max files to include in prompt (default 150) */
  maxPromptFiles?: number;
  /** Max bytes of guidelines to include (default 40_000) */
  maxGuidelinesBytes?: number;
  /** How to mark previous review comments as stale */
  staleCommentStrategy?: "edit-collapse" | "tag-only";
  /** Custom GitHub check name */
  checkName?: string;
}

// ── Review state continuity ──

export interface ReviewIssue {
  id: string;
  file: string;
  severity: ReviewSeverity;
  category?: string;
  summary?: string;
  title?: string;
  body?: string;
  firstRaisedInReview?: number;
}

export interface ResolvedReviewIssue {
  id: string;
  file: string;
  summary?: string;
  resolvedInReview?: number;
}

export interface ReviewState {
  lastReviewedSha: string | null;
  openIssues: ReviewIssue[];
  resolvedIssues: ResolvedReviewIssue[];
  reviewCount: number;
}

// ── Queued review request (stored in automation_session metadata) ──

export interface QueuedReviewRequest {
  reason:
    | "opened"
    | "ready_for_review"
    | "synchronize"
    | "manual"
    | "label_change"
    | "reopen";
  headSha: string;
  requestedAt: string;
  requestedBy?: string;
  mode: "incremental" | "full" | "reset" | "since";
  sinceSha?: string;
  commentId?: string;
  deliveryId?: string;
}

// ── Automation session metadata (JSONB on automation_sessions) ──

export interface AutomationSessionMetadata {
  repositoryOwner: string;
  repositoryName: string;
  prNumber: number;
  prNodeId?: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  lastReviewedSha: string | null;
  reviewState: ReviewState | null;
  reviewCount: number;
  lastCommentId: string | null;
  activeInlineReviewIds?: number[] | null;
  lastInlineReviewId?: number | null;
  /** Maps issue IDs to GitHub review comment database IDs for reply-on-resolve */
  inlineCommentMap?: Record<string, number> | null;
  lastCheckRunId: string | null;
  lastCompletedRunId: string | null;
  pendingReviewRequest: QueuedReviewRequest | null;
  historyRewrittenAt?: string | null;
}

// ── Normalized GitHub PR event ──

export interface NormalizedPrReviewEvent {
  eventType: "pull_request" | "issue_comment";
  action: string;
  installationId: number;
  repositoryId?: string;
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  isOpen: boolean;
  isDraft: boolean;
  senderLogin: string;
  senderType: string;
  senderIsBot: boolean;
  labels: string[];
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  title: string;
  body: string | null;
  commentId?: string;
  commentBody?: string;
  manualCommand?: ManualReviewCommand | null;
}

// ── Manual /review command ──

export interface ManualReviewCommand {
  mode: "incremental" | "full" | "reset" | "since";
  sinceSha?: string;
}

// ── Inline review anchors (transient — used for rendering, not persisted in ReviewState) ──

/** Transient inline anchor data from the model. Used once for rendering, then discarded. */
export interface InlineAnchor {
  issueId: string;
  file: string;
  line: number;
  startLine?: number;
  title: string;
  body: string;
  category?: string;
  suggestion?: string;
}

// ── Parsed review output ──

export type ReviewVerdict = "BLOCK" | "ATTENTION" | "APPROVE";
export type ReviewSeverity = "P0" | "P1" | "P2";

/** Zod schema for the metadata block the agent appends after the comment body. Single source of truth. */
export const ReviewMetadataSchema = z.object({
  verdict: z.enum(["BLOCK", "ATTENTION", "APPROVE"]),
  summary: z.string(),
  severityCounts: z.object({
    P0: z.number(),
    P1: z.number(),
    P2: z.number(),
  }),
  resolvedIssueIds: z.array(z.string()).default([]),
  inlineAnchors: z.array(
    z.object({
      issueId: z.string(),
      file: z.string(),
      line: z.number(),
      startLine: z.number().optional(),
      title: z.string(),
      body: z.string(),
      category: z.string().optional(),
      suggestion: z.string().optional(),
    }),
  ).default([]),
  reviewState: z.object({
    lastReviewedSha: z.string().nullable(),
    openIssues: z.array(
      z.object({
        id: z.string(),
        file: z.string(),
        severity: z.enum(["P0", "P1", "P2"]),
        summary: z.string().optional(),
      }),
    ),
    resolvedIssues: z.array(
      z.object({
        id: z.string(),
        file: z.string(),
        summary: z.string().optional(),
        resolvedInReview: z.number().optional(),
      }),
    ),
    reviewCount: z.number(),
  }),
});

/** Machine-readable metadata the agent appends after the comment body. */
export type ReviewMetadata = z.infer<typeof ReviewMetadataSchema>;

/** Result of parsing agent output: comment body + extracted metadata. */
export interface ParsedReviewOutput {
  /** The agent's markdown output verbatim, with metadata block stripped. Posted directly as the GitHub comment. */
  commentBody: string;
  /** Machine-readable metadata extracted from the trailing JSON block. */
  metadata: ReviewMetadata;
}

// ── Repo guidelines ──

export interface RepoGuidelines {
  rootAgentsMd?: string;
  scopedAgentsMd: Array<{ path: string; content: string }>;
  reviewGuidelinesMd?: string;
}
