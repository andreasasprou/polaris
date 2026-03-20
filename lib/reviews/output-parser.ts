import type { ParsedReviewOutput } from "./types";
import { ReviewMetadataSchema } from "./types";

const METADATA_MARKER = "<!-- polaris:metadata -->";

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
