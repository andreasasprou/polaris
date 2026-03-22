"use client";

import { FileCodeIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ReactNode } from "react";

interface FileRefPillProps {
  path: string;
  fileName: string;
  line?: string;
  lineEnd?: string;
  children?: ReactNode;
}

export function FileRefPill({ path, fileName, line, lineEnd }: FileRefPillProps) {
  let lineLabel = "";
  if (line) {
    lineLabel = `:${line}`;
    if (lineEnd) {
      lineLabel += `-${lineEnd}`;
    }
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="button"
            tabIndex={0}
            className="inline-flex items-center gap-1 rounded-md border border-status-info/30 bg-status-info-dim px-1.5 py-0.5 align-baseline font-mono text-[12px] text-foreground transition-colors hover:bg-status-info/10"
          >
            <FileCodeIcon className="size-3" />
            <span>
              {fileName}
              {lineLabel}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="font-mono text-xs">
            {path}
            {lineLabel}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
