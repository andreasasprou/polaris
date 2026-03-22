import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCredentials } from "@/lib/orchestration/credential-resolver";
import { findAutomationById } from "@/lib/automations/queries";
import { findGithubInstallationByIdAndOrg, findRepositoryByIdAndOrg } from "@/lib/integrations/queries";
import { allocateKeyFromPool, resolveSecretKey } from "@/lib/key-pools/resolve";

vi.mock("@/lib/automations/queries", () => ({
  findAutomationById: vi.fn(),
}));

vi.mock("@/lib/integrations/queries", () => ({
  findGithubInstallationByIdAndOrg: vi.fn(),
  findRepositoryByIdAndOrg: vi.fn(),
}));

vi.mock("@/lib/key-pools/resolve", () => ({
  allocateKeyFromPool: vi.fn(),
  resolveSecretKey: vi.fn(),
}));

describe("resolveCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects persisted automations with an incompatible secret provider", async () => {
    vi.mocked(findAutomationById).mockResolvedValue({
      id: "auto-1",
      organizationId: "org-1",
      repositoryId: "repo-1",
      agentSecretId: "secret-1",
      keyPoolId: null,
      prompt: "Fix it",
      agentType: "codex",
      model: null,
      agentMode: null,
      modelParams: {},
      maxDurationSeconds: 600,
      allowPush: false,
      allowPrCreate: false,
    } as Awaited<ReturnType<typeof findAutomationById>>);
    vi.mocked(resolveSecretKey).mockResolvedValue({
      secretId: "secret-1",
      decryptedKey: "sk-test",
      provider: "anthropic",
    });

    await expect(resolveCredentials("auto-1")).rejects.toMatchObject({
      message: expect.stringContaining('not compatible with agent "codex"'),
      status: 400,
    });
    expect(findRepositoryByIdAndOrg).not.toHaveBeenCalled();
    expect(findGithubInstallationByIdAndOrg).not.toHaveBeenCalled();
  });

  it("returns resolved credentials when the provider matches the agent", async () => {
    vi.mocked(findAutomationById).mockResolvedValue({
      id: "auto-2",
      organizationId: "org-1",
      repositoryId: "repo-1",
      agentSecretId: null,
      keyPoolId: "pool-1",
      prompt: "Fix it",
      agentType: "codex",
      model: "gpt-5.4",
      agentMode: "auto",
      modelParams: { effortLevel: "medium" },
      maxDurationSeconds: 600,
      allowPush: true,
      allowPrCreate: true,
    } as Awaited<ReturnType<typeof findAutomationById>>);
    vi.mocked(allocateKeyFromPool).mockResolvedValue({
      secretId: "secret-2",
      decryptedKey: "sk-live",
      provider: "openai",
    });
    vi.mocked(findRepositoryByIdAndOrg).mockResolvedValue({
      id: "repo-1",
      owner: "acme",
      name: "widget",
      defaultBranch: "main",
      githubInstallationId: "gh-db-1",
    } as Awaited<ReturnType<typeof findRepositoryByIdAndOrg>>);
    vi.mocked(findGithubInstallationByIdAndOrg).mockResolvedValue({
      id: "gh-db-1",
      installationId: 123,
    } as Awaited<ReturnType<typeof findGithubInstallationByIdAndOrg>>);

    await expect(resolveCredentials("auto-2")).resolves.toMatchObject({
      agentType: "codex",
      provider: "openai",
      repositoryOwner: "acme",
      repositoryName: "widget",
      githubInstallationId: 123,
      allowPush: true,
      allowPrCreate: true,
    });
  });
});
