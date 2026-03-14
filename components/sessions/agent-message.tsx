"use client";

import { MarkdownRenderer } from "./markdown-renderer";
import { CopyButton } from "./copy-button";

interface AgentMessageProps {
  text: string;
}

export function AgentMessage({ text }: AgentMessageProps) {
  return (
    <div className="group/msg relative w-full min-w-0 py-1">
      <div className="text-sm text-foreground">
        <MarkdownRenderer>{text}</MarkdownRenderer>
      </div>
      <div className="absolute right-0 top-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
        <CopyButton text={text} />
      </div>
    </div>
  );
}
