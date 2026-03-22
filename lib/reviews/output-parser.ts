import type { ParsedReviewOutput, ReviewVerdict } from "./types";
import { ReviewMetadataSchema } from "./types";

const METADATA_MARKER = "<!-- polaris:metadata -->";

const VERDICT_EMOJI: Record<ReviewVerdict, string> = {
  APPROVE: "✅",
  ATTENTION: "⚠️",
  BLOCK: "🚫",
};

/**
 * Build a regex that matches the exact expected review header for a given
 * verdict and pass number. This is metadata-aware: we parse metadata first,
 * then search for the precise header the agent should have written.
 *
 * Falls back to a loose pattern if verdict/passNumber aren't available.
 */
function buildHeaderRegex(verdict?: ReviewVerdict, passNumber?: number): RegExp {
  if (verdict && passNumber != null) {
    const emoji = VERDICT_EMOJI[verdict];
    const escaped = `##\\s+${emoji}\\s+Polaris Review(?:\\s+Pass\\s+${passNumber}(?!\\d)|\\s+#${passNumber}(?!\\d))`;
    return new RegExp(escaped, "gu");
  }
  // Fallback: any Polaris Review header
  return /##\s+(?:✅|⚠️|🚫)\s+Polaris Review(?:\s+Pass\s+\d+|\s+#\d+)/gu;
}

/**
 * Find the LAST match of a regex in a string.
 * The real review header is closest to the metadata marker — any earlier
 * matches are likely quoted headers in reasoning/preamble text.
 */
function findLastMatch(text: string, re: RegExp): RegExpMatchArray | null {
  let last: RegExpMatchArray | null = null;
  let match;
  while ((match = re.exec(text)) !== null) {
    last = match;
  }
  return last;
}

/**
 * Parse the agent's review output.
 *
 * Strategy:
 * 1. Find the `<!-- polaris:metadata -->` marker and extract JSON metadata.
 * 2. Build an exact header regex from the parsed metadata (verdict + pass number).
 * 3. Find the LAST matching header in the raw body — the real review is closest
 *    to the metadata marker; earlier matches are likely quoted in preamble text.
 * 4. If no header is found, use everything before the marker as-is.
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

  const rawBody = output.slice(0, markerIdx).trim();

  // Build a precise header regex from parsed metadata, then fall back to loose.
  const passNumber = metadata.reviewState.reviewCount;
  const exactRe = buildHeaderRegex(metadata.verdict as ReviewVerdict, passNumber);
  const fallbackRe = buildHeaderRegex();

  // Use LAST match — the real header is closest to the metadata marker.
  const headerMatch = findLastMatch(rawBody, exactRe) ?? findLastMatch(rawBody, fallbackRe);
  const commentBody = headerMatch
    ? rawBody.slice(headerMatch.index!).trim()
    : rawBody;

  return { commentBody, metadata };
}
