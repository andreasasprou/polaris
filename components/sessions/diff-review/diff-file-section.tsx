"use client";

import { useState } from "react";
import { useTheme } from "next-themes";
import { ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import type { FileChange } from "@/lib/diff/types";

const MAX_DISPLAY_LINES = 5000;

/**
 * Reconstruct old/new file content from a unified diff string.
 * Walks each line and separates into old (deletions + context) and new (additions + context).
 */
function splitDiffToOldNew(diff: string): { oldValue: string; newValue: string } {
  const lines = diff.split("\n");
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of lines) {
    // Skip file headers and hunk headers
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@ ") ||
      line.startsWith("\\")
    ) {
      continue;
    }

    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else {
      // Context line
      const content = line.startsWith(" ") ? line.slice(1) : line;
      oldLines.push(content);
      newLines.push(content);
    }
  }

  return {
    oldValue: oldLines.join("\n"),
    newValue: newLines.join("\n"),
  };
}

export function DiffFileSection({ file }: { file: FileChange }) {
  const [open, setOpen] = useState(true);
  const { resolvedTheme } = useTheme();

  const fileName = file.path.split("/").pop() ?? file.path;
  const tooLarge = file.parsedLines.length > MAX_DISPLAY_LINES;
  const isDark = resolvedTheme === "dark";

  const { oldValue, newValue } = splitDiffToOldNew(file.diff);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50">
        <ChevronRightIcon
          className={`size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-150 ${
            open ? "rotate-90" : ""
          }`}
        />

        <span className="min-w-0 truncate font-mono text-xs text-foreground">
          {fileName}
        </span>

        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/50">
          {file.path}
        </span>

        <Badge variant="outline" className="ml-auto shrink-0 text-[10px] px-1.5 py-0">
          {file.action}
        </Badge>

        {file.additions > 0 && (
          <span className="shrink-0 font-mono text-xs text-emerald-600 dark:text-emerald-400">
            +{file.additions}
          </span>
        )}

        {file.deletions > 0 && (
          <span className="shrink-0 font-mono text-xs text-red-600 dark:text-red-400">
            -{file.deletions}
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-1 overflow-hidden rounded-md border border-border">
          {tooLarge ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Diff too large to display ({file.parsedLines.length.toLocaleString()} lines)
            </div>
          ) : (
            <ReactDiffViewer
              oldValue={oldValue}
              newValue={newValue}
              splitView={false}
              useDarkTheme={isDark}
              compareMethod={DiffMethod.LINES}
              hideLineNumbers={false}
              styles={{
                contentText: {
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: "12px",
                  lineHeight: "1.5",
                },
              }}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
