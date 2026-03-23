import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateAutomationRelationsForOrg } from "@/lib/automations/validation";
import { findRepositoryByIdAndOrg } from "@/lib/integrations/queries";
import { validateCredentialRefForAgent } from "@/lib/key-pools/validate";

vi.mock("@/lib/integrations/queries", () => ({
  findRepositoryByIdAndOrg: vi.fn(),
}));

vi.mock("@/lib/key-pools/validate", () => ({
  validateCredentialRefForAgent: vi.fn(),
}));

describe("validateAutomationRelationsForOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults missing agentType to "claude" during credential validation', async () => {
    vi.mocked(validateCredentialRefForAgent).mockResolvedValue({
      provider: "anthropic",
    });

    await expect(
      validateAutomationRelationsForOrg({
        organizationId: "org-1",
        agentType: null,
        agentSecretId: "secret-1",
      }),
    ).resolves.toMatchObject({
      agentSecretId: "secret-1",
      keyPoolId: null,
      repositoryId: null,
    });

    expect(validateCredentialRefForAgent).toHaveBeenCalledWith(
      { type: "secret", secretId: "secret-1" },
      "org-1",
      "claude",
    );
  });

  it("validates repository ownership when a repository is provided", async () => {
    vi.mocked(findRepositoryByIdAndOrg).mockResolvedValue({
      id: "repo-1",
      owner: "acme",
      name: "widget",
    } as Awaited<ReturnType<typeof findRepositoryByIdAndOrg>>);

    await validateAutomationRelationsForOrg({
      organizationId: "org-1",
      repositoryId: "repo-1",
    });

    expect(findRepositoryByIdAndOrg).toHaveBeenCalledWith("repo-1", "org-1");
  });
});
