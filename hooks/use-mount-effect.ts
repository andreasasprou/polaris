import { useEffect } from "react";

/**
 * Run an effect exactly once on mount. Explicit alternative to bare
 * useEffect that signals intent and satisfies the no-useEffect rule
 * in CLAUDE.md.
 */
// eslint-disable-next-line react-hooks/exhaustive-deps
export const useMountEffect = (fn: () => void | (() => void)) => useEffect(fn, []);
