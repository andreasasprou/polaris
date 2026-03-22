import { describe, expect, it } from "vitest";
import {
  assertProviderCompatibleWithAgent,
  isProviderCompatibleWithAgent,
} from "@/lib/key-pools/validate";

describe("key-pool provider compatibility", () => {
  it("accepts providers that match the selected agent", () => {
    expect(isProviderCompatibleWithAgent("openai", "codex")).toBe(true);
    expect(isProviderCompatibleWithAgent("anthropic", "claude")).toBe(true);
  });

  it("rejects providers that do not match the selected agent", () => {
    expect(isProviderCompatibleWithAgent("anthropic", "codex")).toBe(false);
    expect(isProviderCompatibleWithAgent("openai", "claude")).toBe(false);
  });

  it("throws a request error for incompatible providers", () => {
    expect(() =>
      assertProviderCompatibleWithAgent("anthropic", "codex"),
    ).toThrow(/not compatible/);
  });
});
