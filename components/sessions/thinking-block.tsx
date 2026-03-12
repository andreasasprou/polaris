"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface ThinkingBlockProps {
  text: string;
}

export function ThinkingBlock({ text }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.length > 100 ? text.slice(0, 100).trim() + "..." : null;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="w-full min-w-0">
      <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRightIcon
          className={`size-3.5 shrink-0 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <span className="font-medium">Thinking</span>
        {!expanded && preview && (
          <span className="truncate text-muted-foreground/60">
            {preview}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 border-l-2 border-border pl-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
            {text}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
