import { z } from "zod";
import type { ParsedReviewOutput, ReviewVerdict, ReviewFinding } from "./types";

// ── Strict schema (ideal agent output) ──

const ReviewFindingSchema = z.object({
  id: z.string(),
  severity: z.enum(["P0", "P1", "P2"]),
  category: z.string(),
  file: z.string(),
  title: z.string(),
  body: z.string(),
});

const ReviewStateSchema = z.object({
  lastReviewedSha: z.string().nullable(),
  openIssues: z.array(
    z.object({
      id: z.string(),
      file: z.string(),
      severity: z.enum(["P0", "P1", "P2"]),
      category: z.string().optional(),
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

// ── Lenient schema (recovers findings even when some fields are off) ──

const LenientFindingSchema = z.object({
  id: z.string().optional(),
  severity: z.string().optional().default("P2"),
  category: z.string().optional().default("Uncategorized"),
  file: z.string().optional().default("unknown"),
  title: z.string().optional().default(""),
  body: z.string().optional().default(""),
  // Accept description as alias for body (common agent variation)
  description: z.string().optional(),
});

const LenientOutputSchema = z.object({
  verdict: z.string(),
  summary: z.string().optional().default(""),
  severityCounts: z
    .object({ P0: z.number(), P1: z.number(), P2: z.number() })
    .optional(),
  findings: z.array(LenientFindingSchema).optional().default([]),
  resolvedIssueIds: z.array(z.string()).optional().default([]),
  // Accept any shape — agents often emit openIssues as string[] instead of object[]
  reviewState: z.any().optional(),
});

/**
 * Parse the agent's review output to extract structured data.
 *
 * Strategy:
 * 1. Find last fenced JSON block (```json ... ```) — strict parse
 * 2. Find unfenced JSON objects with verdict key — strict parse
 * 3. Re-try all JSON blocks with lenient schema (recovers partial data)
 * 4. Fallback: regex for verdict + severity counts
 * 5. Returns null if unparseable
 */
export function parseReviewOutput(
  output: string,
): ParsedReviewOutput | null {
  const allBlocks = [
    ...extractJsonBlocks(output),
    ...extractUnfencedJson(output),
  ];

  // Strategy 1: Strict parse (last block first — most likely to be the structured output)
  for (const block of [...allBlocks].reverse()) {
    const result = tryParseStrict(block);
    if (result) return result;
  }

  // Strategy 2: Lenient parse — recover findings even when schema doesn't match perfectly
  for (const block of [...allBlocks].reverse()) {
    const result = tryParseLenient(block);
    if (result) return result;
  }

  // Strategy 3: Regex fallback for basic extraction
  return regexFallback(output);
}

/** Strict parse: validates against the full output schema. */
function tryParseStrict(block: string): ParsedReviewOutput | null {
  try {
    const parsed = JSON.parse(block);
    const result = ParsedOutputSchema.safeParse(parsed);
    if (result.success) return result.data;
    console.log("[output-parser] Strict parse failed:", result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Lenient parse: accepts partial/malformed data and normalizes it.
 * Recovers findings even when individual fields have unexpected types or values.
 */
function tryParseLenient(block: string): ParsedReviewOutput | null {
  try {
    const raw = JSON.parse(block);
    const result = LenientOutputSchema.safeParse(raw);
    if (!result.success) return null;

    const data = result.data;

    // Validate verdict
    const verdict = normalizeVerdict(data.verdict);
    if (!verdict) return null;

    // Normalize findings — coerce severity, fill missing fields
    const findings: ReviewFinding[] = data.findings
      .map((f, i) => ({
        id: f.id || `finding-${i + 1}`,
        severity: normalizeSeverity(f.severity),
        category: f.category || "Uncategorized",
        file: f.file || "unknown",
        title: f.title || f.body || f.description || "",
        body: f.body || f.description || f.title || "",
      }))
      .filter((f): f is ReviewFinding => !!f.title || !!f.body);

    // Compute severity counts from actual findings if not provided
    const severityCounts = data.severityCounts ?? {
      P0: findings.filter((f) => f.severity === "P0").length,
      P1: findings.filter((f) => f.severity === "P1").length,
      P2: findings.filter((f) => f.severity === "P2").length,
    };

    // Try to parse reviewState strictly; fall back to synthesized state from findings
    const reviewStateParsed = ReviewStateSchema.safeParse(data.reviewState);
    const reviewState = reviewStateParsed.success
      ? reviewStateParsed.data
      : {
          lastReviewedSha: data.reviewState?.lastReviewedSha ?? null,
          openIssues: findings.map((f) => ({
            id: f.id,
            file: f.file,
            severity: f.severity,
            summary: f.title,
          })),
          resolvedIssues: [],
          reviewCount: data.reviewState?.reviewCount ?? 0,
        };

    return {
      verdict,
      summary: data.summary,
      severityCounts,
      findings,
      resolvedIssueIds: data.resolvedIssueIds,
      reviewState,
    };
  } catch {
    // Not valid JSON
  }
  return null;
}

function normalizeVerdict(v: string): ReviewVerdict | null {
  const upper = v.toUpperCase().trim();
  if (upper === "BLOCK") return "BLOCK";
  if (upper === "ATTENTION") return "ATTENTION";
  if (upper === "APPROVE") return "APPROVE";
  return null;
}

function normalizeSeverity(s: string): "P0" | "P1" | "P2" {
  const upper = s.toUpperCase().trim();
  if (upper === "P0") return "P0";
  if (upper === "P1") return "P1";
  return "P2"; // Default unknown severities to P2
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
