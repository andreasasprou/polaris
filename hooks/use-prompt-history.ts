"use client";

import { useCallback, useRef } from "react";

const MAX_HISTORY = 100;

/**
 * Hook for navigating prompt history with Up/Down arrow keys.
 * Stores sent prompts and allows cycling through them.
 */
export function usePromptHistory() {
  const historyRef = useRef<string[]>([]);
  const indexRef = useRef(-1);
  const draftRef = useRef("");

  const push = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Avoid consecutive duplicates
    if (historyRef.current[0] === trimmed) return;
    historyRef.current.unshift(trimmed);
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current.pop();
    }
    indexRef.current = -1;
    draftRef.current = "";
  }, []);

  /** Navigate up (older). Returns the prompt to display, or null if at boundary. */
  const up = useCallback((currentText: string): string | null => {
    const history = historyRef.current;
    if (history.length === 0) return null;

    // Save draft on first navigation
    if (indexRef.current === -1) {
      draftRef.current = currentText;
    }

    const nextIndex = indexRef.current + 1;
    if (nextIndex >= history.length) return null;

    indexRef.current = nextIndex;
    return history[nextIndex];
  }, []);

  /** Navigate down (newer). Returns the prompt to display, or null if at boundary. */
  const down = useCallback((): string | null => {
    if (indexRef.current <= -1) return null;

    const nextIndex = indexRef.current - 1;
    indexRef.current = nextIndex;

    if (nextIndex === -1) {
      return draftRef.current;
    }

    return historyRef.current[nextIndex];
  }, []);

  const reset = useCallback(() => {
    indexRef.current = -1;
    draftRef.current = "";
  }, []);

  return { push, up, down, reset };
}
