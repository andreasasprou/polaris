import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { codingTask } from "@/trigger/coding-task";
import type { CodingTaskPayload, AgentType } from "@/lib/orchestration/types";
import { mapProjectToRepo } from "@/lib/integrations/sentry";

function verifySentrySignature(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.SENTRY_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Sentry webhook not configured" },
      { status: 500 },
    );
  }

  const rawBody = await req.text();
  const signature = req.headers.get("sentry-hook-signature");

  if (!verifySentrySignature(rawBody, signature, secret)) {
    return NextResponse.json(
      { error: "Invalid signature" },
      { status: 401 },
    );
  }

  const event = JSON.parse(rawBody);

  const repo = mapProjectToRepo(
    event.data?.project_slug ?? event.project_slug,
  );

  const payload: CodingTaskPayload = {
    mode: "new",
    source: "sentry",
    owner: repo.owner,
    repo: repo.repo,
    baseBranch: repo.baseBranch,
    title: `Fix Sentry issue ${event.data?.issue_id ?? event.issue_id}`,
    prompt: [
      "Investigate and fix this production issue.",
      "Use the stack trace and event context included in the webhook payload.",
      "Prefer a small, safe patch and add or update a regression test if possible.",
      "",
      JSON.stringify(event, null, 2),
    ].join("\n"),
    agentType: (process.env.DEFAULT_AGENT as AgentType) ?? undefined,
    sentry: {
      issueId: String(event.data?.issue_id ?? event.issue_id ?? ""),
      fingerprint: Array.isArray(event.data?.fingerprint)
        ? event.data.fingerprint.join(":")
        : undefined,
      permalink: event.data?.web_url,
      title: event.data?.title,
      level: event.data?.level,
    },
  };

  const idempotencyKey = [
    "sentry",
    payload.owner,
    payload.repo,
    payload.sentry?.issueId,
    payload.sentry?.fingerprint,
  ]
    .filter(Boolean)
    .join(":");

  const handle = await codingTask.trigger(payload, {
    idempotencyKey,
    tags: [
      "source:sentry",
      `repo:${payload.owner}/${payload.repo}`,
      payload.sentry?.issueId
        ? `issue:${payload.sentry.issueId}`
        : "issue:unknown",
    ],
    metadata: {
      task: {
        stage: "queued",
        progress: 0,
        repo: payload.repo,
        owner: payload.owner,
        baseBranch: payload.baseBranch,
      },
    },
  });

  return NextResponse.json({ runId: handle.id });
}
