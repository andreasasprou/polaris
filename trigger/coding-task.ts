import { task, wait, logger } from "@trigger.dev/sdk/v3";
import type {
  CodingTaskPayload,
  LegacyCodingTaskPayload,
  AutomationCodingTaskPayload,
  AgentType,
} from "@/lib/orchestration/types";
import { patchTaskStatus } from "@/lib/orchestration/status";
import { buildAgentPrompt } from "@/lib/orchestration/prompts";
import { getInstallationToken, mintInstallationToken } from "@/lib/integrations/github";
import { SandboxManager } from "@/lib/sandbox/SandboxManager";
import { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import { GitOperations } from "@/lib/sandbox/GitOperations";
import { AgentRegistry } from "@/lib/agents/AgentRegistry";
import { ensureSlackThread } from "./ensure-slack-thread";
import { notifySlack } from "./notify-slack";
import { createPr } from "./create-pr";

function slackApprovalBlocks(runId: string, tokenId: string) {
  const mk = (
    text: string,
    style: "primary" | "danger" | undefined,
    accept: boolean,
  ) => ({
    type: "button" as const,
    text: { type: "plain_text" as const, text },
    style,
    action_id: accept ? "approve_agent_action" : "reject_agent_action",
    value: JSON.stringify({ runId, tokenId, accept }),
  });

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Agent task is awaiting approval before execution.",
      },
    },
    {
      type: "actions",
      elements: [
        mk("Approve", "primary", true),
        mk("Reject", "danger", false),
      ],
    },
  ];
}

function isAutomationPayload(
  p: CodingTaskPayload,
): p is AutomationCodingTaskPayload {
  return p.source === "automation";
}

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
  },

  run: async (payload: CodingTaskPayload, { ctx }) => {
    // ── Resolve context depending on payload type ──
    let owner: string;
    let repo: string;
    let baseBranch: string;
    let title: string;
    let prompt: string;
    let agentType: AgentType;
    let agentApiKey: string | undefined;
    let gitToken: string;
    let maxDurationMs = 600_000;
    let allowPush = true;
    let allowPrCreate = true;
    let automationRunId: string | undefined;

    // Slack context (only for legacy payloads)
    let slackChannelId: string | undefined;
    let slackThreadTs: string | undefined;

    // Sentry context (only for legacy payloads)
    let legacyPayload: LegacyCodingTaskPayload | undefined;

    if (isAutomationPayload(payload)) {
      // ── v3 Automation payload ──
      automationRunId = payload.automationRunId;

      // Mark the run as running
      const { updateAutomationRun } = await import(
        "@/lib/automations/actions"
      );
      await updateAutomationRun(automationRunId, {
        status: "running",
        startedAt: new Date(),
      });

      const ctx = await resolveAutomationContext(payload);
      owner = ctx.owner;
      repo = ctx.repo;
      baseBranch = ctx.baseBranch;
      title = ctx.title;
      prompt = ctx.prompt;
      agentType = ctx.agentType;
      agentApiKey = ctx.agentApiKey;
      allowPush = ctx.allowPush;
      allowPrCreate = ctx.allowPrCreate;
      maxDurationMs = ctx.maxDurationSeconds * 1000;

      // Mint a fresh GitHub token using the stored installation ID
      logger.info("Minting installation token", {
        installationId: ctx.githubInstallationId,
        repo: `${owner}/${repo}`,
      });
      gitToken = await mintInstallationToken(
        ctx.githubInstallationId,
        [repo],
        { contents: "write", pull_requests: "write" },
      );
    } else {
      // ── Legacy v2 payload ──
      legacyPayload = payload;
      owner = payload.owner;
      repo = payload.repo;
      baseBranch = payload.baseBranch;
      title = payload.title;
      prompt = payload.prompt;
      agentType =
        payload.agentType ??
        (process.env.DEFAULT_AGENT as AgentType) ??
        "claude";
      slackChannelId = payload.slack?.channelId;
      slackThreadTs = payload.slack?.threadTs;

      // Use env-based API key for legacy payloads
      agentApiKey =
        agentType === "claude"
          ? (process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN!)
          : (process.env.OPENAI_API_KEY ?? process.env.CODEX_AUTH_JSON_B64!);

      logger.info("Minting GitHub installation token", { owner, repo });
      gitToken = await getInstallationToken(owner, repo);
    }

    logger.info("Starting coding task", {
      repo: `${owner}/${repo}`,
      source: payload.source,
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

    // ── Ensure Slack thread (legacy only) ──
    if (slackChannelId) {
      logger.info("Ensuring Slack thread", { channelId: slackChannelId });
      const ensured = await ensureSlackThread
        .triggerAndWait({
          channelId: slackChannelId,
          existingThreadTs: slackThreadTs,
          title,
          repo: `${owner}/${repo}`,
        })
        .unwrap();

      slackThreadTs = ensured.threadTs;
      patchTaskStatus({ threadTs: slackThreadTs });
    }

    patchTaskStatus({
      stage: "starting",
      progress: 0.05,
      summary: title,
    });

    // ── Optional pre-execution approval (legacy sentry) ──
    if (
      legacyPayload?.source === "sentry" &&
      process.env.REQUIRE_SENTRY_APPROVAL === "true"
    ) {
      logger.info("Awaiting Sentry approval");
      patchTaskStatus({ stage: "awaiting_approval", progress: 0.08 });

      const token = await wait.createToken({
        timeout: "30m",
        tags: [`run:${ctx.run.id}`],
      });

      if (slackChannelId && slackThreadTs) {
        await notifySlack.triggerAndWait({
          channelId: slackChannelId,
          threadTs: slackThreadTs,
          text: "Sentry-triggered task awaiting approval before execution.",
          blocks: slackApprovalBlocks(ctx.run.id, token.id),
        });
      }

      const decision = await wait.forToken<{
        accept: boolean;
        reason?: string;
      }>(token);

      if (!decision.ok) {
        throw new Error("Approval timed out");
      }

      if (!decision.output.accept) {
        patchTaskStatus({ stage: "cancelled", progress: 1 });
        return { ok: false, reason: "Rejected in Slack" };
      }
    }

    // ── Create sandbox ──
    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    logger.info("Installation token acquired");

    patchTaskStatus({ stage: "provisioning_sandbox", progress: 0.1 });

    logger.info("Creating sandbox", { repoUrl, baseBranch });
    const sandbox = await sandboxManager.create({
      repoUrl,
      gitToken,
      baseBranch,
      timeoutMs: maxDurationMs,
    });
    logger.info("Sandbox created", { sandboxId: sandbox.sandboxId });

    patchTaskStatus({ sandboxId: sandbox.sandboxId });

    const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
    const git = new GitOperations(commands);

    try {
      // ── Setup git branch ──
      logger.info("Configuring git");
      await git.configure({ repoUrl, gitToken });
      const branchName =
        (legacyPayload?.branchName) ?? `agent/${Date.now()}`;

      if (legacyPayload?.mode === "continue" && legacyPayload.branchName) {
        logger.info("Checking out existing branch", {
          branch: legacyPayload.branchName,
        });
        await git.checkoutBranch(legacyPayload.branchName);
      } else {
        logger.info("Creating branch", { branch: branchName, base: baseBranch });
        await git.createBranch(branchName, baseBranch);
      }

      // Save base commit SHA before agent runs (agents may remove remote refs)
      const baseSha = await git.resolveRef(`origin/${baseBranch}`);
      logger.info("Base commit resolved", { baseSha });

      patchTaskStatus({ branchName, progress: 0.2 });

      // ── Execute agent ──
      patchTaskStatus({ stage: "running_agent", progress: 0.25 });

      if (slackChannelId && slackThreadTs) {
        await notifySlack.triggerAndWait({
          channelId: slackChannelId,
          threadTs: slackThreadTs,
          text: `Running ${agentType} agent on ${owner}/${repo}...`,
        });
      }

      const agentPrompt = legacyPayload
        ? buildAgentPrompt({ ...legacyPayload, branchName })
        : buildAutomationPrompt({ prompt, title, branchName });

      logger.info("Executing agent", {
        agentType,
        promptLength: agentPrompt.length,
      });

      const agent = AgentRegistry.create(agentType, commands);
      const agentResult = await agent.execute(agentPrompt, {
        apiKey: agentApiKey!,
      });

      logger.info("Agent finished", {
        success: agentResult.success,
        changesDetected: agentResult.changesDetected,
        error: agentResult.error,
        stdout: agentResult.output?.slice(0, 3000),
        stderr: agentResult.errorOutput?.slice(0, 3000),
      });

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

      // ── Notify Slack (legacy only) ──
      patchTaskStatus({ stage: "notifying", progress: 0.95 });

      if (slackChannelId && slackThreadTs) {
        await notifySlack.triggerAndWait({
          channelId: slackChannelId,
          threadTs: slackThreadTs,
          text: prUrl
            ? `Done. PR created: ${prUrl}`
            : `Done. ${summary}`,
        });
      }

      // ── Mark success ──
      patchTaskStatus({
        stage: "succeeded",
        progress: 1,
        prUrl,
        summary,
      });

      // Update automation run if applicable
      if (automationRunId) {
        const { updateAutomationRun } = await import(
          "@/lib/automations/actions"
        );
        await updateAutomationRun(automationRunId, {
          status: "succeeded",
          prUrl,
          branchName,
          summary,
          completedAt: new Date(),
        });
      }

      logger.info("Task completed", {
        prUrl,
        commitSha,
        changesDetected: changes.changed,
      });

      return {
        ok: true,
        branchName,
        threadTs: slackThreadTs,
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

      // Update automation run if applicable
      if (automationRunId) {
        const { updateAutomationRun } = await import(
          "@/lib/automations/actions"
        );
        await updateAutomationRun(automationRunId, {
          status: "failed",
          error: message,
          completedAt: new Date(),
        });
      }

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
