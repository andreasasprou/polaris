import { z } from "zod";
import type { ParsedReviewOutput, ReviewVerdict } from "./types";

const ReviewFindingSchema = z.object({
  id: z.string(),
  severity: z.enum(["P0", "P1", "P2"]),
  category: z.string(),
  file: z.string(),
  title: z.string(),
  body: z.string(),
});

const CATEGORIES = [
  "Correctness", "Design", "Security", "Performance", "Tests", "Style",
] as const;

const ReviewStateSchema = z.object({
  lastReviewedSha: z.string().nullable(),
  openIssues: z.array(
    z.object({
      id: z.string(),
      file: z.string(),
      severity: z.enum(["P0", "P1", "P2"]),
      category: z.string().optional(),
      // Accept either summary (our schema) or title/body (agent often mirrors findings format)
      summary: z.string().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      firstRaisedInReview: z.number().optional(),
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
});

const ParsedOutputSchema = z.object({
  verdict: z.enum(["BLOCK", "ATTENTION", "APPROVE"]),
  summary: z.string(),
  severityCounts: z.object({
    P0: z.number(),
    P1: z.number(),
    P2: z.number(),
  }),
  findings: z.array(ReviewFindingSchema),
  resolvedIssueIds: z.array(z.string()).default([]),
  reviewState: ReviewStateSchema,
});

/**
 * Parse the agent's review output to extract structured data.
 *
 * Strategy:
 * 1. Find last fenced JSON block (```json ... ```)
 * 2. Find unfenced JSON objects with verdict key
 * 3. Fallback: regex for verdict + severity counts
 * 4. Returns null if unparseable
 */
export function parseReviewOutput(
  output: string,
): ParsedReviewOutput | null {
  // Strategy 1: Find fenced JSON blocks
  const jsonBlocks = extractJsonBlocks(output);
  for (const block of jsonBlocks.reverse()) {
    const result = tryParseBlock(block);
    if (result) return result;
  }

  // Strategy 2: Find unfenced JSON objects containing "verdict"
  const unfenced = extractUnfencedJson(output);
  for (const block of unfenced.reverse()) {
    const result = tryParseBlock(block);
    if (result) return result;
  }

  // Strategy 3: Regex fallback for basic extraction
  return regexFallback(output);
}

/** Try to parse a JSON string and validate against the output schema. */
function tryParseBlock(block: string): ParsedReviewOutput | null {
  try {
    const parsed = JSON.parse(block);
    const result = ParsedOutputSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Extract all fenced JSON blocks from the output.
 */
function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```json\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

/**
 * Extract unfenced JSON objects that look like review output.
 * Finds top-level { ... } blocks that contain "verdict".
 */
function extractUnfencedJson(text: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        // Only consider objects that look like review output
        if (candidate.includes('"verdict"')) {
          blocks.push(candidate);
        }
        start = -1;
      }
    }
  }

  return blocks;
}

/**
 * Regex fallback: extract verdict and severity counts from prose.
 * Returns null if we can't even determine a verdict.
 */
function regexFallback(output: string): ParsedReviewOutput | null {
  // Try to find verdict
  let verdict: ReviewVerdict | null = null;
  if (/\bBLOCK\b/.test(output)) verdict = "BLOCK";
  else if (/\bATTENTION\b/.test(output)) verdict = "ATTENTION";
  else if (/\bAPPROVE\b/.test(output)) verdict = "APPROVE";

  if (!verdict) return null;

  // Count severity mentions
  const p0Count = (output.match(/\bP0\b/g) ?? []).length;
  const p1Count = (output.match(/\bP1\b/g) ?? []).length;
  const p2Count = (output.match(/\bP2\b/g) ?? []).length;

  // Extract summary — first paragraph after "Summary" heading or first line
  let summary = "";
  const summaryMatch = output.match(
    /(?:^|\n)#+\s*Summary\s*\n+([^\n]+)/i,
  );
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  } else {
    summary = output.split("\n")[0].slice(0, 500);
  }

  return {
    verdict,
    summary,
    severityCounts: {
      P0: Math.max(0, p0Count - 1), // Subtract the one in severity definition
      P1: Math.max(0, p1Count - 1),
      P2: Math.max(0, p2Count - 1),
    },
    findings: [],
    resolvedIssueIds: [],
    reviewState: {
      lastReviewedSha: null,
      openIssues: [],
      resolvedIssues: [],
      reviewCount: 0,
    },
  };
}
