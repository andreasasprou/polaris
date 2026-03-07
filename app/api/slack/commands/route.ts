import { NextRequest, NextResponse } from "next/server";
import { runs } from "@trigger.dev/sdk/v3";
import { verifySlackSignature } from "@/lib/integrations/slack";
import { codingTask } from "@/trigger/coding-task";
import type { CodingTaskPayload, AgentType } from "@/lib/orchestration/types";

function parseAgentCommand(text: string) {
  const agentMatch = text.match(/--agent\s+(claude|codex)/);
  const agentType = agentMatch?.[1] as AgentType | undefined;
  const cleanText = text.replace(/--agent\s+(claude|codex)/, "").trim();

  const [repoRef, ...rest] = cleanText.split(/\s+/);
  const prompt = rest.join(" ").trim();

  const [owner, repo] = repoRef.split("/");
  if (!owner || !repo || !prompt) {
    throw new Error("Usage: /agent owner/repo prompt [--agent claude|codex]");
  }

  return { owner, repo, prompt, agentType };
}

export async function POST(req: NextRequest) {
  const raw = await req.text();

  if (!verifySlackSignature(raw, req.headers)) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  const form = new URLSearchParams(raw);
  const command = form.get("command")!;
  const text = form.get("text") ?? "";
  const channelId = form.get("channel_id")!;
  const userId = form.get("user_id")!;

  if (command === "/agent") {
    const { owner, repo, prompt, agentType } = parseAgentCommand(text);

    const payload: CodingTaskPayload = {
      mode: "new",
      source: "slack",
      owner,
      repo,
      baseBranch: "main",
      title: `Slack requested task for ${owner}/${repo}`,
      prompt,
      agentType,
      slack: {
        channelId,
        userId,
      },
    };

    const handle = await codingTask.trigger(payload, {
      tags: ["source:slack", `repo:${owner}/${repo}`],
      metadata: {
        task: {
          stage: "queued",
          progress: 0,
          repo,
          owner,
          baseBranch: "main",
          agentType: agentType ?? process.env.DEFAULT_AGENT ?? "claude",
        },
      },
    });

    return NextResponse.json({
      response_type: "ephemeral",
      text: `Queued (${agentType ?? "default"} agent). Run ID: ${handle.id}`,
    });
  }

  if (command === "/agent-followup") {
    const [runId, ...rest] = text.trim().split(/\s+/);
    const prompt = rest.join(" ").trim();

    if (!runId || !prompt) {
      return NextResponse.json({
        response_type: "ephemeral",
        text: "Usage: /agent-followup run_xxx your follow-up instruction",
      });
    }

    const run = await runs.retrieve(runId);
    const meta = (run.metadata?.task ?? {}) as Record<string, string>;

    if (!meta.branchName) {
      return NextResponse.json({
        response_type: "ephemeral",
        text: `Run ${runId} does not have a branch name for follow-up.`,
      });
    }

    const payload: CodingTaskPayload = {
      mode: "continue",
      source: "slack",
      owner: meta.owner,
      repo: meta.repo,
      baseBranch: meta.baseBranch,
      title: `Follow-up for ${runId}`,
      prompt,
      agentType: meta.agentType as AgentType | undefined,
      branchName: meta.branchName,
      previousRunId: runId,
      slack: {
        channelId,
        userId,
        threadTs: meta.threadTs,
      },
    };

    const handle = await codingTask.trigger(payload, {
      tags: ["source:slack", `repo:${meta.owner}/${meta.repo}`],
      metadata: {
        task: {
          stage: "queued",
          progress: 0,
          repo: meta.repo,
          owner: meta.owner,
          baseBranch: meta.baseBranch,
          branchName: meta.branchName,
          threadTs: meta.threadTs,
        },
      },
    });

    return NextResponse.json({
      response_type: "ephemeral",
      text: `Follow-up queued. New run ID: ${handle.id}`,
    });
  }

  return NextResponse.json({
    response_type: "ephemeral",
    text: `Unknown command: ${command}`,
  });
}
