import { z } from "zod";
import type { ParsedReviewOutput } from "./types";

const METADATA_MARKER = "<!-- polaris:metadata -->";

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
 * Finds the `<!-- polaris:metadata -->` marker, extracts the JSON block
 * after it, and returns the comment body (everything before the marker)
 * alongside the validated metadata.
 */
export function parseReviewOutput(
  output: string,
): ParsedReviewOutput | null {
  const markerIdx = output.lastIndexOf(METADATA_MARKER);
  if (markerIdx === -1) return null;

  const commentBody = output.slice(0, markerIdx).trim();
  const afterMarker = output.slice(markerIdx + METADATA_MARKER.length);

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
