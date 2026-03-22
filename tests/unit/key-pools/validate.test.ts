import { describe, expect, it } from "vitest";
import {
  assertProviderCompatibleWithAgent,
  isProviderCompatibleWithAgent,
} from "@/lib/key-pools/validate";

describe("credential provider compatibility", () => {
  it("accepts providers supported by the selected agent", () => {
    expect(isProviderCompatibleWithAgent("openai", "codex")).toBe(true);
    expect(isProviderCompatibleWithAgent("anthropic", "claude")).toBe(true);
  });

  it("rejects providers not supported by the selected agent", () => {
    expect(isProviderCompatibleWithAgent("anthropic", "codex")).toBe(false);
    expect(isProviderCompatibleWithAgent("openai", "claude")).toBe(false);
  });

  it("throws for incompatible provider and agent combinations", () => {
    expect(() =>
      assertProviderCompatibleWithAgent("anthropic", "codex"),
    ).toThrow(/not compatible/);
  });
});
