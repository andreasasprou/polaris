"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CopyIcon, CheckIcon } from "lucide-react";

const CODEX_AUTH_FILE_CMD = `base64 < ~/.codex/auth.json | tr -d '\\n' | pbcopy`;
const CODEX_AUTH_KEYCHAIN_CMD = `security find-generic-password -s "Codex Auth" -w | base64 | tr -d '\\n' | pbcopy`;

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="size-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy command"}
    >
      {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
    </Button>
  );
}

export function CodexOAuthInstructions() {
  return (
    <div className="rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
      <p className="mb-2">
        Run{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">codex auth</code>{" "}
        first, then paste the output of:
      </p>
      <div className="flex flex-col gap-1.5">
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            From file
          </p>
          <div className="flex items-center gap-2 rounded bg-muted px-3 py-2 font-mono">
            <code className="flex-1 select-all break-all text-foreground">
              {CODEX_AUTH_FILE_CMD}
            </code>
            <CopyButton text={CODEX_AUTH_FILE_CMD} />
          </div>
        </div>
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            From macOS Keychain
          </p>
          <div className="flex items-center gap-2 rounded bg-muted px-3 py-2 font-mono">
            <code className="flex-1 select-all break-all text-foreground">
              {CODEX_AUTH_KEYCHAIN_CMD}
            </code>
            <CopyButton text={CODEX_AUTH_KEYCHAIN_CMD} />
          </div>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground/70">
        Note: OAuth tokens are single-use. If you use Codex locally after
        saving, you may need to re-export.
      </p>
    </div>
  );
}
