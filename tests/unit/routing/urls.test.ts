import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppBaseUrl, runUrl } from "@/lib/config/urls";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("config/urls", () => {
  it("builds org-scoped run URLs", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://plrs.sh");

    expect(runUrl("run-123", "acme")).toBe("https://plrs.sh/acme/runs/run-123");
  });

  it("falls back to unscoped run URLs when no org slug is available", () => {
    vi.stubEnv("VERCEL_URL", "preview.plrs.sh");

    expect(getAppBaseUrl()).toBe("https://preview.plrs.sh");
    expect(runUrl("run-123")).toBe("https://preview.plrs.sh/runs/run-123");
  });
});
