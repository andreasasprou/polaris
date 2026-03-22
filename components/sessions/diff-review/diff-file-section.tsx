"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { DiffLine } from "./diff-line";
import type { FileChange } from "@/lib/diff/types";

const MAX_DISPLAY_LINES = 5000;

export function DiffFileSection({ file }: { file: FileChange }) {
  const [open, setOpen] = useState(true);

  const fileName = file.path.split("/").pop() ?? file.path;
  const tooLarge = file.parsedLines.length > MAX_DISPLAY_LINES;

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
        <div className="mt-1 overflow-hidden rounded-md border border-border bg-muted/10">
          {tooLarge ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Diff too large to display ({file.parsedLines.length.toLocaleString()} lines)
            </div>
          ) : (
            <div className="overflow-x-auto">
              {file.parsedLines.map((line, i) => (
                <DiffLine key={i} line={line} />
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
