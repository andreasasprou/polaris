import {
  getModels,
  getThoughtLevels,
  resolveAgentConfig,
} from "./agent-profiles";
import type { AgentType, ModelParams } from "./types";

export type RuntimeConfigInput = {
  agentType: AgentType;
  model?: string | null;
  modelParams?: ModelParams | null;
};

export function normalizeModel(model?: string | null): string {
  return model?.trim() ?? "";
}

export function normalizeModelParams(
  modelParams?: ModelParams | null,
): ModelParams {
  if (!modelParams?.effortLevel) {
    return {};
  }
  return { effortLevel: modelParams.effortLevel };
}

export function validateRuntimeConfig(
  input: RuntimeConfigInput,
): string | null {
  const normalizedModel = normalizeModel(input.model);
  const normalizedParams = normalizeModelParams(input.modelParams);

  const allowedModels = getModels(input.agentType);
  if (
    normalizedModel &&
    allowedModels.length > 0 &&
    !allowedModels.includes(normalizedModel)
  ) {
    return `Invalid model "${normalizedModel}" for agent "${input.agentType}". Valid models: ${allowedModels.join(", ")}`;
  }

  const allowedEffort = getThoughtLevels(input.agentType);
  if (
    normalizedParams.effortLevel &&
    allowedEffort &&
    !allowedEffort.includes(normalizedParams.effortLevel)
  ) {
    return `Invalid effort level "${normalizedParams.effortLevel}" for agent "${input.agentType}". Valid levels: ${allowedEffort.join(", ")}`;
  }

  return null;
}

export function resolveInteractiveRuntimeConfig(input: RuntimeConfigInput) {
  const normalizedModel = normalizeModel(input.model);
  const normalizedParams = normalizeModelParams(input.modelParams);

  return resolveAgentConfig({
    agentType: input.agentType,
    modeIntent: "interactive",
    model: normalizedModel || undefined,
    effortLevel: normalizedParams.effortLevel,
  });
}
