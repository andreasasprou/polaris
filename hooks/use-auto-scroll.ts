"use client";

import { useRef, useCallback, useEffect, useState } from "react";

const BOTTOM_THRESHOLD = 40;
const PROGRAMMATIC_GRACE_MS = 150;

interface UseAutoScrollOptions {
  /** Dependency that triggers auto-scroll when it changes (e.g. items.length) */
  dependency: number;
}

export function useAutoScroll({ dependency }: UseAutoScrollOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const programmaticUntilRef = useRef(0);

  const checkIsAtBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticUntilRef.current = Date.now() + PROGRAMMATIC_GRACE_MS;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "instant",
    });
    setIsAtBottom(true);
  }, []);

  // Track user scroll position
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    // Ignore programmatic scrolls
    if (Date.now() < programmaticUntilRef.current) return;

    const atBottom = checkIsAtBottom(el);
    setIsAtBottom(atBottom);
  }, [checkIsAtBottom]);

  // Auto-scroll when dependency changes and user is at bottom
  useEffect(() => {
    if (!isAtBottom) return;
    // Use rAF to let the DOM update first
    const frame = requestAnimationFrame(() => {
      scrollToBottom(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [dependency, isAtBottom, scrollToBottom]);

  return {
    scrollRef,
    isAtBottom,
    scrollToBottom,
    handleScroll,
  };
}
