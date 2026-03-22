import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NormalizedPrReviewEvent, PRReviewConfig } from "@/lib/reviews/types";

/**
 * Focused wiring test for dispatchPrReview().
 *
 * Verifies three critical integration points fixed in this PR:
 * 1. Repo config loaded from event.baseRef (not headSha)
 * 2. Raw full changed-file list passed to shouldReviewPR()
 * 3. Post-ignorePaths reviewed paths passed to loadRepoGuidelines() with event.baseRef
 *
 * These tests mock all external dependencies and verify call arguments.
 */

// ── Shared state for mocks ──

const mockOctokit = {} as import("octokit").Octokit;

const calls = {
  loadRepoReviewConfig: [] as unknown[][],
  fetchFullFileList: [] as unknown[][],
  shouldReviewPR: [] as unknown[][],
  loadRepoGuidelines: [] as unknown[][],
  failCheck: [] as unknown[][],
  updateAutomationRun: [] as unknown[][],
};

function resetCalls() {
  for (const key of Object.keys(calls) as (keyof typeof calls)[]) {
    calls[key] = [];
  }
}

// ── Mocks ──

vi.mock("@/lib/automations/actions", () => ({
  getAutomationSession: vi.fn().mockResolvedValue({
    id: "session-1",
    interactiveSessionId: "isession-1",
    metadata: {
      repositoryOwner: "test-org",
      repositoryName: "test-repo",
      prNumber: 42,
      baseRef: "main",
      baseSha: "base123",
      headRef: "feature",
      headSha: "head456",
      lastReviewedSha: null,
      reviewState: null,
      reviewCount: 0,
      lastCommentId: null,
      lastCheckRunId: null,
      lastCompletedRunId: null,
      pendingReviewRequest: null,
    },
  }),
  updateAutomationRun: vi.fn().mockImplementation((...args: unknown[]) => {
    calls.updateAutomationRun.push(args);
    return Promise.resolve();
  }),
  tryAcquireAutomationSessionLock: vi.fn().mockResolvedValue(true),
  releaseAutomationSessionLock: vi.fn().mockResolvedValue(undefined),
  setPendingReviewRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/automations/queries", () => ({
  findAutomationById: vi.fn().mockResolvedValue({
    id: "auto-1",
    prReviewConfig: {
      customPrompt: "Original prompt",
      ignorePaths: ["*.lock"],
      skipDrafts: true,
      skipBots: true,
    } satisfies PRReviewConfig,
    agentType: "claude",
    model: "claude-sonnet-4-20250514",
    modelParams: null,
    agentSecretId: null,
    keyPoolId: null,
    repositoryId: "repo-1",
  }),
}));

vi.mock("@/lib/reviews/github", () => ({
  getReviewOctokit: vi.fn().mockResolvedValue(mockOctokit),
  createPendingCheck: vi.fn().mockResolvedValue({ checkRunId: "check-1" }),
  completeCheck: vi.fn().mockResolvedValue(undefined),
  failCheck: vi.fn().mockImplementation((...args: unknown[]) => {
    calls.failCheck.push(args);
    return Promise.resolve();
  }),
  isAncestor: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/reviews/repo-config", () => ({
  loadRepoReviewConfig: vi.fn().mockImplementation((...args: unknown[]) => {
    calls.loadRepoReviewConfig.push(args);
    return Promise.resolve({ status: "not_found" as const });
  }),
  mergeWithConnector: vi.fn().mockImplementation(
    (def: unknown, auto: { prReviewConfig: PRReviewConfig | null }) => ({
      definition: def,
      reviewConfig: {
        ...(auto.prReviewConfig ?? {}),
        customPrompt: "YAML instructions",
        ignorePaths: ["*.lock"],
      },
      agentType: "claude",
      model: "claude-sonnet-4-20250514",
      modelParams: {},
      credentialRef: {},
    }),
  ),
  formatConfigError: vi.fn().mockReturnValue("Review config error: test"),
}));

vi.mock("@/lib/reviews/diff", () => ({
  fetchFullFileList: vi.fn().mockImplementation((...args: unknown[]) => {
    calls.fetchFullFileList.push(args);
    return Promise.resolve(["src/index.ts", "package-lock.json", "src/lib/utils.ts"]);
  }),
  fetchPRDiff: vi.fn().mockResolvedValue({
    diff: "diff content",
    files: ["src/index.ts", "src/lib/utils.ts"],
    truncated: false,
  }),
  fetchPRFileList: vi.fn().mockResolvedValue(["src/index.ts", "src/lib/utils.ts"]),
  fetchCommitRangeDiff: vi.fn().mockResolvedValue({
    diff: "range diff",
    files: ["src/index.ts"],
    truncated: false,
  }),
}));

vi.mock("@/lib/reviews/guidelines", () => ({
  loadRepoGuidelines: vi.fn().mockImplementation((...args: unknown[]) => {
    calls.loadRepoGuidelines.push(args);
    return Promise.resolve({ scopedAgentsMd: [] });
  }),
}));

vi.mock("@/lib/reviews/filters", () => ({
  shouldReviewPR: vi.fn().mockImplementation((...args: unknown[]) => {
    calls.shouldReviewPR.push(args);
    return { review: true };
  }),
}));

vi.mock("@/lib/reviews/classification", () => ({
  classifyFiles: vi.fn().mockReturnValue(new Map()),
  filterIgnoredPaths: vi.fn().mockImplementation(
    (files: string[], patterns: string[]) => {
      // Simulate real filtering: remove *.lock
      if (patterns.includes("*.lock")) {
        return files.filter((f: string) => !f.endsWith(".lock") && !f.endsWith(".json"));
      }
      return files;
    },
  ),
}));

vi.mock("@/lib/reviews/prompt-builder", () => ({
  buildReviewPrompt: vi.fn().mockReturnValue("mock review prompt"),
}));

vi.mock("@/lib/sessions/actions", () => ({
  getInteractiveSession: vi.fn().mockResolvedValue({
    id: "isession-1",
    status: "idle",
    sandboxBaseUrl: "http://sandbox:3000",
    epoch: 1,
    sandboxId: "sb-1",
    sdkSessionId: "sdk-1",
    nativeAgentSessionId: null,
    agentType: "claude",
  }),
  casSessionStatus: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/jobs/callback-auth", () => ({
  generateJobHmacKey: vi.fn().mockReturnValue("hmac-key"),
}));

vi.mock("@/lib/jobs/actions", () => ({
  createJob: vi.fn().mockResolvedValue({
    id: "job-1",
    timeoutSeconds: 1800,
  }),
  createJobAttempt: vi.fn().mockResolvedValue({ id: "attempt-1" }),
  getActiveJobForSession: vi.fn().mockResolvedValue(null),
  casAttemptStatus: vi.fn().mockResolvedValue(true),
  casJobStatus: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/sandbox-agent/agent-profiles", () => ({
  resolveAgentConfig: vi.fn().mockReturnValue({
    agent: "claude",
    mode: "read-only",
    model: "claude-sonnet-4-20250514",
    thoughtLevel: "medium",
  }),
}));

vi.mock("@/lib/sandbox-agent/queries", () => ({
  getNextEventIndex: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/compute/claims", () => ({
  createClaim: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/orchestration/prompt-dispatch", () => ({
  probeSandboxHealth: vi.fn().mockResolvedValue(true),
  buildCallbackUrl: vi.fn().mockReturnValue("http://callback"),
  resolveSessionCredentials: vi.fn().mockResolvedValue({
    credentialRef: {},
    repositoryOwner: "test-org",
    repositoryName: "test-repo",
    defaultBranch: "main",
    githubInstallationId: 1,
  }),
}));

vi.mock("@/lib/evlog", () => ({
  useLogger: vi.fn().mockReturnValue({ set: vi.fn() }),
}));

// Mock fetch globally for the dispatch POST
const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
  new Response(null, { status: 202 }),
);

// ── Test helpers ──

function makeEvent(overrides?: Partial<NormalizedPrReviewEvent>): NormalizedPrReviewEvent {
  return {
    eventType: "pull_request",
    action: "opened",
    installationId: 1,
    owner: "test-org",
    repo: "test-repo",
    prNumber: 42,
    prUrl: "https://github.com/test-org/test-repo/pull/42",
    isOpen: true,
    isDraft: false,
    senderLogin: "developer",
    senderType: "User",
    senderIsBot: false,
    labels: [],
    baseRef: "main",
    baseSha: "base123",
    headRef: "feature",
    headSha: "head456",
    title: "Add feature",
    body: "Description",
    ...overrides,
  };
}

function makeInput(eventOverrides?: Partial<NormalizedPrReviewEvent>) {
  return {
    orgId: "org-1",
    automationId: "auto-1",
    automationSessionId: "session-1",
    automationRunId: "run-1",
    installationId: 1,
    deliveryId: "delivery-1",
    normalizedEvent: makeEvent(eventOverrides),
    checkRunId: "check-1",
  };
}

// ── Tests ──

describe("dispatchPrReview wiring", () => {
  beforeEach(() => {
    resetCalls();
    vi.clearAllMocks();
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));
  });

  it("loads repo config from event.baseRef, not headSha", async () => {
    const { dispatchPrReview } = await import("@/lib/orchestration/pr-review");

    await dispatchPrReview(makeInput({ baseRef: "develop", headSha: "abc123" }));

    expect(calls.loadRepoReviewConfig.length).toBe(1);
    const [octokit, owner, repo, ref] = calls.loadRepoReviewConfig[0];
    expect(octokit).toBe(mockOctokit);
    expect(owner).toBe("test-org");
    expect(repo).toBe("test-repo");
    expect(ref).toBe("develop"); // baseRef, NOT headSha
  });

  it("fetches full uncapped file list via fetchFullFileList", async () => {
    const { dispatchPrReview } = await import("@/lib/orchestration/pr-review");

    await dispatchPrReview(makeInput());

    expect(calls.fetchFullFileList.length).toBe(1);
    const [octokit, owner, repo, prNumber] = calls.fetchFullFileList[0];
    expect(octokit).toBe(mockOctokit);
    expect(owner).toBe("test-org");
    expect(repo).toBe("test-repo");
    expect(prNumber).toBe(42);
  });

  it("passes raw full file list to shouldReviewPR", async () => {
    const { dispatchPrReview } = await import("@/lib/orchestration/pr-review");

    await dispatchPrReview(makeInput());

    expect(calls.shouldReviewPR.length).toBe(1);
    const [_event, _config, changedFiles] = calls.shouldReviewPR[0];
    // Should be the full uncapped list, not a capped subset
    expect(changedFiles).toEqual(["src/index.ts", "package-lock.json", "src/lib/utils.ts"]);
  });

  it("loads guidelines from event.baseRef with reviewed paths", async () => {
    const { dispatchPrReview } = await import("@/lib/orchestration/pr-review");

    await dispatchPrReview(makeInput({ baseRef: "main" }));

    expect(calls.loadRepoGuidelines.length).toBe(1);
    const [octokit, owner, repo, ref, paths] = calls.loadRepoGuidelines[0];
    expect(octokit).toBe(mockOctokit);
    expect(owner).toBe("test-org");
    expect(repo).toBe("test-repo");
    expect(ref).toBe("main"); // baseRef, NOT headSha
    // reviewedPaths should be post-ignorePaths filtered (*.lock removed)
    expect(paths).toEqual(["src/index.ts", "src/lib/utils.ts"]);
  });

  it("fails check and returns early on invalid repo config", async () => {
    const { loadRepoReviewConfig } = await import("@/lib/reviews/repo-config");
    vi.mocked(loadRepoReviewConfig).mockResolvedValueOnce({
      status: "invalid",
      file: "default.yaml",
      error: "'name' is required",
    });

    const { dispatchPrReview } = await import("@/lib/orchestration/pr-review");
    const result = await dispatchPrReview(makeInput());

    expect(result.jobId).toBe("");
    expect(calls.failCheck.length).toBe(1);
    // Should NOT have called shouldReviewPR or loadRepoGuidelines
    expect(calls.shouldReviewPR.length).toBe(0);
    expect(calls.loadRepoGuidelines.length).toBe(0);
  });

  it("fails check on multiple config files", async () => {
    const { loadRepoReviewConfig } = await import("@/lib/reviews/repo-config");
    vi.mocked(loadRepoReviewConfig).mockResolvedValueOnce({
      status: "multiple",
      files: ["default.yaml", "security.yaml"],
    });

    const { dispatchPrReview } = await import("@/lib/orchestration/pr-review");
    const result = await dispatchPrReview(makeInput());

    expect(result.jobId).toBe("");
    expect(calls.failCheck.length).toBe(1);

    // Run should be marked failed
    const failedUpdate = calls.updateAutomationRun.find(
      (args) => (args[1] as { status?: string })?.status === "failed",
    );
    expect(failedUpdate).toBeTruthy();
  });

  it("falls through to connector config on not_found", async () => {
    const { loadRepoReviewConfig } = await import("@/lib/reviews/repo-config");
    vi.mocked(loadRepoReviewConfig).mockResolvedValueOnce({
      status: "not_found",
    });

    const { dispatchPrReview } = await import("@/lib/orchestration/pr-review");
    await dispatchPrReview(makeInput());

    // Should proceed normally — shouldReviewPR called
    expect(calls.shouldReviewPR.length).toBe(1);
    expect(calls.loadRepoGuidelines.length).toBe(1);
  });
});
