"use client";

import { ArrowDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface ScrollToBottomButtonProps {
  visible: boolean;
  onClick: () => void;
}

export function ScrollToBottomButton({ visible, onClick }: ScrollToBottomButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "absolute bottom-4 right-4 z-10 flex size-8 items-center justify-center",
        "rounded-full border border-border bg-background/90 shadow-md backdrop-blur-sm",
        "transition-all duration-200",
        "hover:bg-muted hover:shadow-lg",
        "active:scale-95",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0",
      )}
      aria-label="Scroll to bottom"
      tabIndex={visible ? 0 : -1}
    >
      <ArrowDownIcon className="size-4 text-muted-foreground" />
    </button>
  );
}
