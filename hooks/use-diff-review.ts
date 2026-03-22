import { useMemo } from "react";
import { extractFileChanges, extractPrUrl } from "@/lib/diff/extract-file-changes";
import type { ChatItem } from "@/lib/sandbox-agent/event-types";
import type { DiffSummary } from "@/lib/diff/types";

export function useDiffReview(items: ChatItem[]): {
  summary: DiffSummary;
  prUrl: string | null;
} {
  const summary = useMemo(() => extractFileChanges(items), [items]);
  const prUrl = useMemo(() => extractPrUrl(items), [items]);

  return { summary, prUrl };
}
