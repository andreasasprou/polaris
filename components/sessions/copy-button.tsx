"use client";

import { useState, useCallback } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  text: string;
  className?: string;
}

export function CopyButton({ text, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "flex items-center justify-center rounded-md p-1 text-muted-foreground/50 transition-all hover:bg-muted hover:text-muted-foreground",
        copied && "text-emerald-500 hover:text-emerald-500",
        className,
      )}
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <CheckIcon className="size-3.5" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  );
}
