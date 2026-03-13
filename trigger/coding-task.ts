import { task, streams, logger, metadata } from "@trigger.dev/sdk/v3";
import type {
  AutomationCodingTaskPayload,
  AgentType,
} from "@/lib/orchestration/types";
import { patchTaskStatus, getTaskStatus } from "@/lib/orchestration/status";
import { mintInstallationToken } from "@/lib/integrations/github";
import { SandboxManager } from "@/lib/sandbox/SandboxManager";
import { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import { GitOperations } from "@/lib/sandbox/GitOperations";
import { SandboxHealthMonitor } from "@/lib/sandbox/SandboxHealthMonitor";
import { SandboxAgentBootstrap } from "@/lib/sandbox-agent/SandboxAgentBootstrap";
import {
  SandboxAgentClient,
  type SandboxAgentEvent,
} from "@/lib/sandbox-agent/SandboxAgentClient";
import { buildSessionEnv } from "@/lib/sandbox-agent/credentials";
import { createPersistDriver } from "@/lib/sandbox-agent/persist";
import { resolveAgentConfig, applyFilesystemConfig } from "@/lib/sandbox-agent/agent-profiles";
import { resolveSnapshotSource } from "@/lib/sandbox/snapshots/queries";
import { createPr } from "./create-pr";

/**
 * Resolve everything needed to run an automation task.
 * Returns a normalized context object.
 */
async function resolveAutomationContext(payload: AutomationCodingTaskPayload) {
  const { resolveCredentials } = await import("@/lib/credentials/resolver");
  const creds = await resolveCredentials(payload.automationId);
  if (!creds) {
    throw new Error(
      `Failed to resolve credentials for automation ${payload.automationId}`,
    );
  }

  // Derive a title from the trigger event
  const event = payload.triggerEvent;
  let title = "Automation task";
  if (event.action && event.pull_request) {
    const pr = event.pull_request as Record<string, unknown>;
    title = `PR ${event.action}: ${pr.title ?? ""}`;
  } else if (event.ref && event.commits) {
    const commits = event.commits as Array<Record<string, unknown>>;
    title = `Push to ${String(event.ref).replace("refs/heads/", "")}: ${commits[0]?.message ?? ""}`;
  }

  return {
    owner: creds.repositoryOwner,
    repo: creds.repositoryName,
    baseBranch: creds.defaultBranch,
    title: title.slice(0, 200),
    prompt: creds.prompt,
    agentType: creds.agentType as AgentType,
    agentApiKey: creds.agentApiKey,
    agentMode: creds.agentMode,
    model: creds.model,
    modelParams: creds.modelParams,
    githubInstallationId: creds.githubInstallationId,
    maxDurationSeconds: creds.maxDurationSeconds,
    allowPush: creds.allowPush,
    allowPrCreate: creds.allowPrCreate,
  };
}

const sandboxManager = new SandboxManager();

export const codingTask = task({
  id: "coding-task",

  onCancel: async () => {
    patchTaskStatus({
      stage: "cancelled",
      progress: 1,
    });
    // Clean up sandbox — the finally block won't run on cancellation
    const status = getTaskStatus();
    if (status.sandboxId) {
      await sandboxManager.destroyById(status.sandboxId);
    }
  },

  onFailure: async () => {
    // Clean up sandbox when task is killed by maxDuration, crash, etc.
    const status = getTaskStatus();
    if (status.sandboxId) {
      await sandboxManager.destroyById(status.sandboxId);
    }
  },

  run: async (payload: AutomationCodingTaskPayload) => {
    const { automationRunId } = payload;

    // Mark the run as running
    const { updateAutomationRun } = await import("@/lib/automations/actions");
    await updateAutomationRun(automationRunId, {
      status: "running",
      startedAt: new Date(),
    });

    const ctx = await resolveAutomationContext(payload);
    const { owner, repo, baseBranch, title, prompt, agentType, allowPush, allowPrCreate } = ctx;
    const agentMode = ctx.agentMode ?? undefined;
    const model = ctx.model ?? undefined;
    const modelParams = ctx.modelParams ?? {};
    const agentApiKey = ctx.agentApiKey;
    const maxDurationMs = ctx.maxDurationSeconds * 1000;

    // Mint a fresh GitHub token using the stored installation ID
    logger.info("Minting installation token", {
      installationId: ctx.githubInstallationId,
      repo: `${owner}/${repo}`,
    });
    const gitToken = await mintInstallationToken(
      ctx.githubInstallationId,
      [repo],
      { contents: "write", pull_requests: "write" },
    );

    logger.info("Starting coding task", {
      repo: `${owner}/${repo}`,
      agentType,
      automationRunId,
    });

    patchTaskStatus({
      stage: "queued",
      progress: 0,
      repo,
      owner,
      baseBranch,
      agentType,
    });

    patchTaskStatus({
      stage: "starting",
      progress: 0.05,
      summary: title,
    });

    // ── Create sandbox ──
    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    logger.info("Installation token acquired");

    patchTaskStatus({ stage: "provisioning_sandbox", progress: 0.1 });

    // Resolve snapshot for faster startup
    const source = await resolveSnapshotSource(agentType);

    logger.info("Creating sandbox", { repoUrl, baseBranch, source: source.type });
    const sandbox = await sandboxManager.create({
      source,
      repoUrl,
      gitToken,
      baseBranch,
      timeoutMs: maxDurationMs,
      ports: [2468],
    });
    logger.info("Sandbox created", { sandboxId: sandbox.sandboxId });

    patchTaskStatus({ sandboxId: sandbox.sandboxId });

    const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
    const git = new GitOperations(commands);

    try {
      // ── Setup git branch ──
      logger.info("Configuring git");
      await git.configure({ repoUrl });
      const branchName = `agent/${Date.now()}`;
      logger.info("Creating branch", { branch: branchName, base: baseBranch });
      await git.createBranch(branchName, baseBranch);

      // Save base commit SHA before agent runs (agents may remove remote refs)
      const baseSha = await git.resolveRef(`origin/${baseBranch}`);
      logger.info("Base commit resolved", { baseSha });

      patchTaskStatus({ branchName, progress: 0.2 });

      // ── Execute agent ──
      patchTaskStatus({ stage: "running_agent", progress: 0.25 });

      const agentPrompt = buildAutomationPrompt({ prompt, title, branchName });

      logger.info("Executing agent", {
        agentType,
        promptLength: agentPrompt.length,
      });

      // ── Bootstrap Sandbox Agent server (skip install when using snapshot) ──
      const bootstrap = new SandboxAgentBootstrap(sandbox, commands);

      const sessionEnv = buildSessionEnv(agentType, agentApiKey!);

      if (source.type === "git") {
        await bootstrap.install();
        await bootstrap.installAgent(agentType, sessionEnv);
      }

      const serverUrl = await bootstrap.start(2468, sessionEnv);
      logger.info("Sandbox Agent server started", { serverUrl });

      // Connect SDK with Postgres persistence for event replay
      const persist = createPersistDriver();
      const client = await SandboxAgentClient.connect({
        baseUrl: serverUrl,
        persist,
      });

      const resolved = resolveAgentConfig({
        agentType,
        modeIntent: "autonomous",
        modeOverride: agentMode,
        model,
        effortLevel: (modelParams as Record<string, unknown>)?.effortLevel as string | undefined,
      });

      // Write filesystem config (e.g. .claude/settings.json) if needed
      if (resolved.filesystemConfig) {
        await applyFilesystemConfig(
          (cmd, opts) => commands.runShell(cmd, opts),
          SandboxManager.PROJECT_DIR,
          resolved.filesystemConfig,
        );
      }

      const session = await client.createSession({
        agent: resolved.agent,
        model: resolved.model,
        mode: resolved.mode,
        thoughtLevel: resolved.thoughtLevel,
        cwd: SandboxManager.PROJECT_DIR,
      });
      logger.info("Agent session created", { sessionId: session.id });

      // Link the session to the automation run for event replay
      await updateAutomationRun(automationRunId, {
        agentSessionId: session.id,
      });
      metadata.set("agentSessionId", session.id);

      // Event stream bridge — forwards onEvent callbacks to output stream
      let eventForwarder: ((event: SandboxAgentEvent) => void) | null = null;
      const streamControl = { resolve: () => {} };
      const streamDone = new Promise<void>((r) => {
        streamControl.resolve = r;
      });

      const { waitUntilComplete: waitForEventStream } = streams.writer(
        "events",
        {
          execute: async ({ write }) => {
            eventForwarder = (event) => write(event);
            await streamDone;
          },
        },
      );

      const healthMonitor = new SandboxHealthMonitor(serverUrl);
      healthMonitor.start();

      const agentResult = await client.executePrompt(session, agentPrompt, {
        timeoutMs: maxDurationMs - 60_000, // Reserve 60s for post-agent git ops
        signal: healthMonitor.signal,
        onEvent: (event) => {
          eventForwarder?.(event);

          // Log event types for debugging
          const payload = event.payload as Record<string, unknown>;
          if (payload?.type) {
            logger.debug("Agent event", {
              type: payload.type,
              sender: event.sender,
            });
          }
        },
      });

      healthMonitor.stop();
      streamControl.resolve();
      await waitForEventStream();

      await client.destroySession(session.id);
      await client.dispose();

      logger.info("Agent finished", {
        success: agentResult.success,
        error: agentResult.error,
        stopReason: agentResult.stopReason,
      });

      // Store agent output in metadata for debugging (visible via MCP)
      metadata.set("agentOutput", agentResult.output?.slice(0, 2000) ?? "");
      metadata.set("agentError", agentResult.errorOutput?.slice(0, 2000) ?? "");

      // ── Collect results ──
      patchTaskStatus({ stage: "collecting_results", progress: 0.7 });

      // Ensure we're on the expected branch
      await git.ensureBranch(branchName);

      const changes = await git.checkChanges(baseSha);

      const summary = changes.changed
        ? `Agent made changes:\n${changes.diffSummary}`
        : "Agent completed without making changes.";

      patchTaskStatus({ summary });

      let prUrl: string | undefined;
      let commitSha: string | undefined;

      if (changes.changed && allowPush) {
        // ── Commit and push ──
        logger.info("Committing and pushing", { branch: branchName });
        const gitResult = await git.commitAndPush(
          branchName,
          `fix: ${title}`,
          baseSha,
        );
        commitSha = gitResult.commitSha;
        logger.info("Push result", { commitSha, pushed: gitResult.pushed });

        patchTaskStatus({
          stage: "creating_pr",
          progress: 0.85,
          commitSha,
        });

        if (gitResult.pushed && allowPrCreate) {
          logger.info("Creating PR", {
            head: branchName,
            base: baseBranch,
          });

          const pr = await createPr
            .triggerAndWait({
              owner,
              repo,
              head: branchName,
              base: baseBranch,
              title,
              body: `Automated PR by Polaris (${agentType} agent).\n\n${changes.diffSummary}`,
            })
            .unwrap();

          prUrl = pr.url;
          logger.info("PR created", { prUrl, prNumber: pr.number });
          patchTaskStatus({ prUrl });
        } else if (!gitResult.pushed) {
          logger.error("Push failed", {
            stderr: gitResult.pushStderr?.slice(0, 2000),
          });
        }
      } else if (!changes.changed) {
        logger.info("No changes detected — skipping commit and PR");
      } else {
        logger.info("Push disabled by automation policy — skipping");
      }

      // ── Mark success ──
      patchTaskStatus({
        stage: "succeeded",
        progress: 1,
        prUrl,
        summary,
      });

      await updateAutomationRun(automationRunId, {
        status: "succeeded",
        prUrl,
        branchName,
        summary,
        completedAt: new Date(),
      });

      logger.info("Task completed", {
        prUrl,
        commitSha,
        changesDetected: changes.changed,
      });

      return {
        ok: true,
        branchName,
        prUrl,
        commitSha,
        agentType,
        changesDetected: changes.changed,
        summary,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Task failed", { error: message });
      patchTaskStatus({
        stage: "failed",
        progress: 1,
        error: { message },
      });

      await updateAutomationRun(automationRunId, {
        status: "failed",
        error: message,
        completedAt: new Date(),
      });

      throw error;
    } finally {
      logger.info("Destroying sandbox");
      await sandboxManager.destroy(sandbox);
    }
  },
});

/**
 * Build a prompt for automation-triggered tasks.
 */
function buildAutomationPrompt(input: {
  prompt: string;
  title: string;
  branchName: string;
}): string {
  return [
    `Task: ${input.title}`,
    "",
    input.prompt,
    "",
    "REQUIREMENTS:",
    `1. You are on branch ${input.branchName}. Make changes on this branch.`,
    "2. Make the smallest safe fix.",
    "3. Run the most relevant checks available in the repo.",
    "4. Do NOT commit or push — the orchestrator handles git operations.",
    "5. Do not open a PR yourself.",
    "",
    "OUTPUT STYLE:",
    "- Be concise in intermediate messages.",
    "- Prefer concrete repo actions over general commentary.",
  ].join("\n");
}
