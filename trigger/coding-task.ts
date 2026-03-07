import { task, wait, logger } from "@trigger.dev/sdk/v3";
import type { CodingTaskPayload, AgentType } from "@/lib/orchestration/types";
import { patchTaskStatus } from "@/lib/orchestration/status";
import { buildAgentPrompt } from "@/lib/orchestration/prompts";
import { getInstallationToken } from "@/lib/integrations/github";
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
    const agentType: AgentType =
      payload.agentType ??
      (process.env.DEFAULT_AGENT as AgentType) ??
      "claude";

    logger.info("Starting coding task", {
      repo: `${payload.owner}/${payload.repo}`,
      source: payload.source,
      mode: payload.mode,
      agentType,
    });

    patchTaskStatus({
      stage: "queued",
      progress: 0,
      repo: payload.repo,
      owner: payload.owner,
      baseBranch: payload.baseBranch,
      agentType,
    });

    // 1. Ensure Slack thread
    let threadTs = payload.slack?.threadTs;
    if (payload.slack?.channelId) {
      logger.info("Ensuring Slack thread", { channelId: payload.slack.channelId });
      const ensured = await ensureSlackThread
        .triggerAndWait({
          channelId: payload.slack.channelId,
          existingThreadTs: payload.slack.threadTs,
          title: payload.title,
          repo: `${payload.owner}/${payload.repo}`,
        })
        .unwrap();

      threadTs = ensured.threadTs;
      patchTaskStatus({ threadTs });
    }

    patchTaskStatus({
      stage: "starting",
      progress: 0.05,
      summary: payload.title,
    });

    // 2. Optional pre-execution approval for sentry tasks
    if (
      payload.source === "sentry" &&
      process.env.REQUIRE_SENTRY_APPROVAL === "true"
    ) {
      logger.info("Awaiting Sentry approval");
      patchTaskStatus({ stage: "awaiting_approval", progress: 0.08 });

      const token = await wait.createToken({
        timeout: "30m",
        tags: [`run:${ctx.run.id}`],
      });

      if (payload.slack?.channelId && threadTs) {
        await notifySlack.triggerAndWait({
          channelId: payload.slack.channelId,
          threadTs,
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

    // 3. Mint GitHub installation token
    logger.info("Minting GitHub installation token", {
      owner: payload.owner,
      repo: payload.repo,
    });
    const gitToken = await getInstallationToken(payload.owner, payload.repo);
    const repoUrl = `https://github.com/${payload.owner}/${payload.repo}.git`;
    logger.info("Installation token acquired");

    // 4. Create sandbox
    patchTaskStatus({ stage: "provisioning_sandbox", progress: 0.1 });

    const agentApiKey =
      agentType === "claude"
        ? (process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN!)
        : (process.env.OPENAI_API_KEY ?? process.env.CODEX_AUTH_JSON_B64!);

    logger.info("Creating sandbox", { repoUrl, baseBranch: payload.baseBranch });
    const sandbox = await sandboxManager.create({
      repoUrl,
      gitToken,
      baseBranch: payload.baseBranch,
      timeoutMs: 600_000,
    });
    logger.info("Sandbox created", { sandboxId: sandbox.sandboxId });

    patchTaskStatus({ sandboxId: sandbox.sandboxId });

    const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
    const git = new GitOperations(commands);

    try {
      // 5. Setup git branch
      logger.info("Configuring git");
      await git.configure({ repoUrl, gitToken });
      const branchName = payload.branchName ?? `agent/${Date.now()}`;

      if (payload.mode === "continue" && payload.branchName) {
        logger.info("Checking out existing branch", { branch: payload.branchName });
        await git.checkoutBranch(payload.branchName);
      } else {
        logger.info("Creating branch", { branch: branchName, base: payload.baseBranch });
        await git.createBranch(branchName, payload.baseBranch);
      }

      // Save base commit SHA before agent runs (agents may remove remote refs)
      const baseSha = await git.resolveRef(`origin/${payload.baseBranch}`);
      logger.info("Base commit resolved", { baseSha });

      patchTaskStatus({ branchName, progress: 0.2 });

      // 6. Execute agent
      patchTaskStatus({ stage: "running_agent", progress: 0.25 });

      if (payload.slack?.channelId && threadTs) {
        await notifySlack.triggerAndWait({
          channelId: payload.slack.channelId,
          threadTs,
          text: `Running ${agentType} agent on ${payload.owner}/${payload.repo}...`,
        });
      }

      const prompt = buildAgentPrompt({ ...payload, branchName });
      logger.info("Executing agent", { agentType, promptLength: prompt.length });

      const agent = AgentRegistry.create(agentType, commands);
      const agentResult = await agent.execute(prompt, { apiKey: agentApiKey });

      logger.info("Agent finished", {
        success: agentResult.success,
        changesDetected: agentResult.changesDetected,
        error: agentResult.error,
      });

      // 7. Collect results
      patchTaskStatus({ stage: "collecting_results", progress: 0.7 });

      // Ensure we're on the expected branch before checking changes
      // (agent may have detached HEAD or switched branches)
      await git.ensureBranch(branchName);

      const changes = await git.checkChanges(baseSha);

      const summary = changes.changed
        ? `Agent made changes:\n${changes.diffSummary}`
        : "Agent completed without making changes.";

      patchTaskStatus({ summary });

      let prUrl: string | undefined;
      let commitSha: string | undefined;

      if (changes.changed) {
        // 8. Commit and push
        logger.info("Committing and pushing", { branch: branchName });
        const gitResult = await git.commitAndPush(
          branchName,
          `fix: ${payload.title}`,
          baseSha,
        );
        commitSha = gitResult.commitSha;
        logger.info("Push result", { commitSha, pushed: gitResult.pushed });

        patchTaskStatus({
          stage: "creating_pr",
          progress: 0.85,
          commitSha,
        });

        if (gitResult.pushed) {
          logger.info("Creating PR", {
            head: branchName,
            base: payload.baseBranch,
          });

          const pr = await createPr
            .triggerAndWait({
              owner: payload.owner,
              repo: payload.repo,
              head: branchName,
              base: payload.baseBranch,
              title: payload.title,
              body: `Automated PR by Polaris (${agentType} agent).\n\n${changes.diffSummary}`,
            })
            .unwrap();

          prUrl = pr.url;
          logger.info("PR created", { prUrl, prNumber: pr.number });
          patchTaskStatus({ prUrl });
        } else {
          logger.error("Push failed", { stderr: gitResult.pushStderr?.slice(0, 2000) });
        }
      } else {
        logger.info("No changes detected — skipping commit and PR");
      }

      // 9. Notify Slack
      patchTaskStatus({ stage: "notifying", progress: 0.95 });

      if (payload.slack?.channelId && threadTs) {
        await notifySlack.triggerAndWait({
          channelId: payload.slack.channelId,
          threadTs,
          text: prUrl
            ? `Done. PR created: ${prUrl}`
            : `Done. ${summary}`,
        });
      }

      // 10. Mark success
      patchTaskStatus({
        stage: "succeeded",
        progress: 1,
        prUrl,
        summary,
      });

      logger.info("Task completed", { prUrl, commitSha, changesDetected: changes.changed });

      return {
        ok: true,
        branchName,
        threadTs,
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
      throw error;
    } finally {
      logger.info("Destroying sandbox");
      await sandboxManager.destroy(sandbox);
    }
  },
});
