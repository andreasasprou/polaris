import { z } from "zod";
import type { ParsedReviewOutput, ReviewMetadata } from "./types";

const METADATA_MARKER = "<!-- polaris:metadata -->";

// ── Schema for the small metadata block ──

const ReviewMetadataSchema = z.object({
  verdict: z.enum(["BLOCK", "ATTENTION", "APPROVE"]),
  summary: z.string(),
  severityCounts: z.object({
    P0: z.number(),
    P1: z.number(),
    P2: z.number(),
  }),
  resolvedIssueIds: z.array(z.string()).default([]),
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

/**
 * Parse the agent's review output.
 *
 * Primary: find `<!-- polaris:metadata -->` marker, extract JSON after it.
 * Fallback: legacy fenced JSON (backwards compat during rollout).
 */
export function parseReviewOutput(
  output: string,
): ParsedReviewOutput | null {
  // Primary: marker-based extraction
  const markerResult = extractViaMarker(output);
  if (markerResult) return markerResult;

  // Fallback: legacy fenced JSON block containing verdict
  return extractLegacyFallback(output);
}

// ── Primary: marker-based extraction ──

function extractViaMarker(output: string): ParsedReviewOutput | null {
  const markerIdx = output.lastIndexOf(METADATA_MARKER);
  if (markerIdx === -1) return null;

  const commentBody = output.slice(0, markerIdx).trim();
  const afterMarker = output.slice(markerIdx + METADATA_MARKER.length);

  // Extract ```json ... ``` block after the marker
  const jsonMatch = afterMarker.match(/```json\s*\n([\s\S]*?)```/);
  if (!jsonMatch) return null;

  try {
    const raw = JSON.parse(jsonMatch[1].trim());
    const result = ReviewMetadataSchema.safeParse(raw);
    if (!result.success) return null;

    return { commentBody, metadata: result.data };
  } catch {
    return null;
  }
}

// ── Legacy fallback: fenced JSON with verdict key ──

function extractLegacyFallback(output: string): ParsedReviewOutput | null {
  // Find all fenced JSON blocks
  const blocks: string[] = [];
  const regex = /```json\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    blocks.push(match[1].trim());
  }

  // Also find unfenced JSON objects with "verdict"
  let depth = 0;
  let start = -1;
  for (let i = 0; i < output.length; i++) {
    if (output[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (output[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = output.slice(start, i + 1);
        if (candidate.includes('"verdict"')) blocks.push(candidate);
        start = -1;
      }
    }
  }

  // Try each block (last first — most likely to be the structured output)
  for (const block of [...blocks].reverse()) {
    const result = tryParseLegacyBlock(block, output);
    if (result) return result;
  }

  return null;
}

function tryParseLegacyBlock(
  block: string,
  fullOutput: string,
): ParsedReviewOutput | null {
  try {
    const raw = JSON.parse(block);
    if (!raw.verdict) return null;

    const verdict = normalizeVerdict(String(raw.verdict));
    if (!verdict) return null;

    const summary = String(raw.summary ?? "");
    const severityCounts = raw.severityCounts ?? { P0: 0, P1: 0, P2: 0 };
    const resolvedIssueIds = Array.isArray(raw.resolvedIssueIds)
      ? raw.resolvedIssueIds
      : [];

    // Parse reviewState — accept any shape and normalize
    const reviewState = normalizeReviewState(raw.reviewState);

    const metadata: ReviewMetadata = {
      verdict,
      summary,
      severityCounts,
      resolvedIssueIds,
      reviewState,
    };

    // Strip the JSON block from the output to get the comment body
    // Find and remove the last fenced JSON block
    const lastFenceIdx = fullOutput.lastIndexOf("```json");
    const commentBody = lastFenceIdx >= 0
      ? fullOutput.slice(0, lastFenceIdx).trim()
      : fullOutput.trim();

    return { commentBody, metadata };
  } catch {
    return null;
  }
}

function normalizeVerdict(v: string): "BLOCK" | "ATTENTION" | "APPROVE" | null {
  const upper = v.toUpperCase().trim();
  if (upper === "BLOCK") return "BLOCK";
  if (upper === "ATTENTION") return "ATTENTION";
  if (upper === "APPROVE") return "APPROVE";
  return null;
}

function normalizeReviewState(raw: unknown): ReviewMetadata["reviewState"] {
  const fallback = {
    lastReviewedSha: null,
    openIssues: [] as Array<{ id: string; file: string; severity: "P0" | "P1" | "P2"; summary?: string }>,
    resolvedIssues: [] as Array<{ id: string; file: string; summary?: string; resolvedInReview?: number }>,
    reviewCount: 0,
  };

  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as Record<string, unknown>;

  return {
    lastReviewedSha: typeof obj.lastReviewedSha === "string" ? obj.lastReviewedSha : null,
    openIssues: Array.isArray(obj.openIssues)
      ? obj.openIssues.map((item: unknown, i: number) => {
          if (typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).id === "string") {
            const o = item as Record<string, unknown>;
            return {
              id: o.id as string,
              file: (o.file as string) ?? "unknown",
              severity: normalizeSeverity(String(o.severity ?? "P2")),
              summary: o.summary as string | undefined ?? o.title as string | undefined,
            };
          }
          if (typeof item === "string") {
            return { id: item, file: "unknown", severity: "P2" as const };
          }
          return { id: `open-issue-${i + 1}`, file: "unknown", severity: "P2" as const };
        })
      : [],
    resolvedIssues: Array.isArray(obj.resolvedIssues)
      ? obj.resolvedIssues.filter(
          (item: unknown) => typeof item === "object" && item !== null,
        ) as typeof fallback.resolvedIssues
      : [],
    reviewCount: typeof obj.reviewCount === "number" ? obj.reviewCount : 0,
  };
}

function normalizeSeverity(s: string): "P0" | "P1" | "P2" {
  const upper = s.toUpperCase().trim();
  if (upper === "P0") return "P0";
  if (upper === "P1") return "P1";
  return "P2";
}
