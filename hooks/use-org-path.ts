"use client";

import { useParams } from "next/navigation";
import { orgPath } from "@/lib/config/urls";

export function useOrgSlug(): string {
  return useParams<{ orgSlug: string }>().orgSlug;
}

export function useOrgPath() {
  const slug = useOrgSlug();
  return (path: string) => orgPath(slug, path);
}
