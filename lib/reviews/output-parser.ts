import type { ParsedReviewOutput } from "./types";
import { ReviewMetadataSchema } from "./types";

const METADATA_MARKER = "<!-- polaris:metadata -->";

/**
 * Regex matching the review header line the agent is instructed to write.
 * Matches: ## ✅ Polaris Review #N: APPROVE (and ⚠️/🚫 ATTENTION/BLOCK variants)
 */
const REVIEW_HEADER_RE = /^##\s+(?:✅|⚠️|🚫|[\u{1F7E0}-\u{1F7FF}])\s+Polaris Review\s+#\d+/mu;

/**
 * Parse the agent's review output.
 *
 * Strategy:
 * 1. Find the `<!-- polaris:metadata -->` marker and extract JSON metadata.
 * 2. For the comment body, try to find the review header (`## ✅ Polaris Review #N`)
 *    to trim any pre-review text (thinking, tool call output, etc.).
 * 3. If no header is found, use everything before the marker as-is.
 */
export function parseReviewOutput(
  output: string,
): ParsedReviewOutput | null {
  const markerIdx = output.lastIndexOf(METADATA_MARKER);
  if (markerIdx === -1) return null;

  const afterMarker = output.slice(markerIdx + METADATA_MARKER.length);

  const jsonMatch = afterMarker.match(/```json\s*\n([\s\S]*?)```/);
  if (!jsonMatch) return null;

  let metadata;
  try {
    const raw = JSON.parse(jsonMatch[1].trim());
    const result = ReviewMetadataSchema.safeParse(raw);
    if (!result.success) return null;
    metadata = result.data;
  } catch {
    return null;
  }

  // Extract comment body: everything before the metadata marker.
  const rawBody = output.slice(0, markerIdx).trim();

  // Try to find the review header to strip any pre-review text
  // (e.g., thinking output, tool call results from earlier segments).
  const headerMatch = rawBody.match(REVIEW_HEADER_RE);
  const commentBody = headerMatch
    ? rawBody.slice(headerMatch.index!).trim()
    : rawBody;

  return { commentBody, metadata };
}
