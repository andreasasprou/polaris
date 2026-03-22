"use client";

import { ExternalLinkIcon, FileCodeIcon } from "lucide-react";
import type { DiffSummary } from "@/lib/diff/types";

export function DiffReviewHeader({
  summary,
  prUrl,
}: {
  summary: DiffSummary;
  prUrl: string | null;
}) {
  return (
    <div className="flex items-center gap-3 px-2 py-2">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <FileCodeIcon className="size-3.5" />
        <span>
          {summary.totalFiles} {summary.totalFiles === 1 ? "file" : "files"} changed
        </span>
      </div>

      {summary.totalAdditions > 0 && (
        <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
          +{summary.totalAdditions}
        </span>
      )}

      {summary.totalDeletions > 0 && (
        <span className="font-mono text-xs text-red-600 dark:text-red-400">
          -{summary.totalDeletions}
        </span>
      )}

      {prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          View on GitHub
          <ExternalLinkIcon className="size-3" />
        </a>
      )}
    </div>
  );
}
