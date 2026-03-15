"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircleIcon } from "lucide-react";
import { parseSessionError, PHASE_LABELS } from "@/lib/errors/session-errors";

export function SessionErrorAlert({ error }: { error: string | null }) {
  const parsed = parseSessionError(error);
  if (!parsed) return null;

  const phaseLabel = PHASE_LABELS[parsed.phase] ?? "Session";

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertCircleIcon className="h-4 w-4" />
      <AlertTitle>Failed during: {phaseLabel}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{parsed.message}</p>
        {parsed.recoveryHint && (
          <p className="text-muted-foreground text-sm">{parsed.recoveryHint}</p>
        )}
        {parsed.detail && parsed.detail !== parsed.message && (
          <details className="mt-2">
            <summary className="text-xs text-muted-foreground cursor-pointer">
              Technical details
            </summary>
            <pre className="text-xs mt-1 whitespace-pre-wrap">{parsed.detail}</pre>
          </details>
        )}
      </AlertDescription>
    </Alert>
  );
}
