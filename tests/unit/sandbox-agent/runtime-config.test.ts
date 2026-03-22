import { describe, expect, it } from "vitest";
import {
  normalizeModel,
  normalizeModelParams,
  resolveInteractiveRuntimeConfig,
  validateRuntimeConfig,
} from "@/lib/sandbox-agent/runtime-config";

describe("runtime-config", () => {
  it("normalizes blank model params to an empty object", () => {
    expect(normalizeModelParams(undefined)).toEqual({});
    expect(normalizeModelParams({})).toEqual({});
  });

  it("trims models before validation", () => {
    expect(normalizeModel("  gpt-5.4  ")).toBe("gpt-5.4");
  });

  it("rejects models that do not belong to the selected agent", () => {
    expect(
      validateRuntimeConfig({
        agentType: "claude",
        model: "gpt-5.4",
        modelParams: {},
      }),
    ).toContain('Invalid model "gpt-5.4"');
  });

  it("rejects unsupported effort levels for the selected agent", () => {
    expect(
      validateRuntimeConfig({
        agentType: "codex",
        model: "gpt-5.4",
        modelParams: { effortLevel: "max" },
      }),
    ).toContain('Invalid effort level "max"');
  });

  it("resolves interactive runtime config with persisted model and effort", () => {
    expect(
      resolveInteractiveRuntimeConfig({
        agentType: "codex",
        model: "gpt-5.4",
        modelParams: { effortLevel: "xhigh" },
      }),
    ).toMatchObject({
      agent: "codex",
      mode: "auto",
      model: "gpt-5.4",
      thoughtLevel: "xhigh",
    });
  });
});
