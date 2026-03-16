/**
 * v2 PLACEHOLDER — Prompt dispatch.
 *
 * This file previously contained the v1 5-tier dispatch routing with Trigger.dev.
 * It will be rewritten in Phase 3 with the v2 implementation:
 *   - Tier 1: sandbox alive → CAS idle→active, POST /prompt
 *   - Tier 2: sandbox dead → restore/create, increment epoch, then Tier 1
 *
 * The new implementation lives in lib/orchestration/ (Phase 3).
 */

export type DispatchResult = {
  jobId: string;
};

/**
 * Dispatch a prompt to a session's sandbox.
 * TODO(v2-phase3): Implement v2 dispatch.
 */
export async function dispatchPromptToSession(_input: {
  sessionId: string;
  prompt: string;
  requestId: string;
  source: string;
}): Promise<DispatchResult> {
  throw new Error(
    "v1 prompt dispatch has been removed. v2 dispatch not yet implemented (Phase 3).",
  );
}

/**
 * Resolve agent API key + repository info for a session.
 * Shared by session creation and prompt dispatch.
 */
export async function resolveSessionCredentials(session: {
  organizationId: string;
  agentType: string;
  agentSecretId: string | null;
  repositoryId: string | null;
}) {
  let agentApiKey: string | undefined;

  if (session.agentSecretId) {
    const { getDecryptedSecretForOrg } = await import("@/lib/secrets/queries");
    agentApiKey =
      (await getDecryptedSecretForOrg(session.agentSecretId, session.organizationId)) ?? undefined;
  }

  if (!agentApiKey) {
    throw new Error(
      "No agent API key configured. Add one in Settings → Secrets.",
    );
  }

  let repositoryOwner: string | undefined;
  let repositoryName: string | undefined;
  let defaultBranch: string | undefined;
  let githubInstallationId: number | undefined;

  if (session.repositoryId) {
    const { findRepositoryById, findGithubInstallationById } = await import(
      "@/lib/integrations/queries"
    );
    const repo = await findRepositoryById(session.repositoryId);
    if (repo) {
      repositoryOwner = repo.owner;
      repositoryName = repo.name;
      defaultBranch = repo.defaultBranch;
      const installation = await findGithubInstallationById(
        repo.githubInstallationId,
      );
      if (installation) {
        githubInstallationId = installation.installationId;
      }
    }
  }

  if (!repositoryOwner || !repositoryName || !githubInstallationId) {
    throw new Error("Could not resolve repository for resume");
  }

  return {
    agentApiKey,
    repositoryOwner,
    repositoryName,
    defaultBranch,
    githubInstallationId,
  };
}
