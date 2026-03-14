"use client";

interface UserMessageProps {
  text: string;
}

export function UserMessage({ text }: UserMessageProps) {
  return (
    <div className="flex w-full flex-col items-end">
      <div className="w-fit max-w-[min(82%,64ch)]">
        <div className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
          {text}
        </div>
      </div>
    </div>
  );
}
