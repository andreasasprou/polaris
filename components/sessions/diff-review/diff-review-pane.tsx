"use client";

import { useDiffReview } from "@/hooks/use-diff-review";
import { DiffReviewHeader } from "./diff-review-header";
import { DiffFileSection } from "./diff-file-section";
import type { ChatItem } from "@/lib/sandbox-agent/event-types";

export function DiffReviewPane({ items }: { items: ChatItem[] }) {
  const { summary, prUrl } = useDiffReview(items);

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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-none">
      <DiffReviewHeader summary={summary} prUrl={prUrl} />
      <div className="flex flex-col gap-2 px-1 pb-4">
        {summary.files.map((file) => (
          <DiffFileSection key={file.path} file={file} />
        ))}
      </div>
    </div>
  );
}
