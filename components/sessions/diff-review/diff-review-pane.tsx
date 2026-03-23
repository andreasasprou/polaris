"use client";

import { DiffReviewHeader } from "./diff-review-header";
import { DiffFileSection } from "./diff-file-section";
import type { DiffSummary } from "@/lib/diff/types";

export function DiffReviewPane({
  summary,
  prUrl,
}: {
  summary: DiffSummary;
  prUrl: string | null;
}) {

  if (summary.totalFiles === 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="text-sm text-muted-foreground">
          No file changes in this session
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <DiffReviewHeader summary={summary} prUrl={prUrl} />
      <div className="flex flex-col gap-2 px-1 pb-4">
        {summary.files.map((file) => (
          <DiffFileSection key={file.path} file={file} />
        ))}
      </div>
    </div>
  );
}
