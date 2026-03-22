"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useOrgSlug } from "@/hooks/use-org-path";

/**
 * Sidebar keyboard shortcuts.
 *
 * - Cmd+Shift+N: navigate to new session page
 *   (Cmd+N conflicts with browser "new window")
 */
export function useSidebarKeyboard() {
  const router = useRouter();
  const orgSlug = useOrgSlug();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Cmd+Shift+N (Mac) or Ctrl+Shift+N (Windows/Linux)
      if (
        event.key === "N" &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey
      ) {
        event.preventDefault();
        router.push(`/${orgSlug}/sessions/new`);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router, orgSlug]);
}
