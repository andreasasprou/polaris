import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/auth-schema";
import { repositories } from "@/lib/integrations/schema";
import { createAutomation } from "@/lib/automations/actions";
import { and, eq } from "drizzle-orm";
import type { Intent } from "@/app/(auth)/onboarding/_components/step-intent";

const PR_REVIEW_PROMPT = `## Role

You are a senior code reviewer performing a structured PR review. Your job is to identify real issues that matter — bugs, security vulnerabilities, design problems, and missing tests — while ignoring style preferences and nitpicks.

**Review contract:**
- Only raise issues you are confident about
- Every finding must reference a specific file and explain the problem concretely
- Assign severity honestly: P0 for blocking issues, P1 for important concerns, P2 for suggestions
- If the code looks good, say so — don't manufacture issues to fill a quota

## Severity Levels

- **P0 (Blocking):** Bugs that will break production, security vulnerabilities, data loss risks, crashes. The PR should NOT be merged until fixed.
- **P1 (Important):** Design issues, missing error handling, performance problems, missing tests for critical paths. Should be addressed before merge.
- **P2 (Suggestion):** Code improvements, better naming, minor refactoring ideas. Nice to have but not blocking.`;

const CODING_TASK_PROMPT = `You are an autonomous coding agent. Analyze the codebase, implement the requested changes, and create a pull request with your work.

Follow the repository's coding conventions, run any available linters or type checks, and write clear commit messages. If you encounter ambiguity, make the most reasonable choice and note it in the PR description.`;

type TemplateConfig = {
  name: string;
  mode: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  prompt: string;
  agentType: string;
  allowPush: boolean;
  allowPrCreate: boolean;
  prReviewConfig?: Record<string, unknown>;
};

function getTemplateForIntent(intent: Intent): TemplateConfig | null {
  switch (intent) {
    case "pr-review":
      return {
        name: "PR Review Bot",
        mode: "continuous",
        triggerType: "github",
        triggerConfig: {
          events: [
            "pull_request.opened",
            "pull_request.synchronize",
            "pull_request.ready_for_review",
            "pull_request.reopened",
          ],
        },
        prompt: PR_REVIEW_PROMPT,
        agentType: "claude",
        allowPush: false,
        allowPrCreate: false,
        prReviewConfig: {
          skipDraftPrs: true,
          skipBotPrs: true,
          ignorePaths: [],
        },
      };
    case "coding-tasks":
      return {
        name: "Coding Task Automation",
        mode: "oneshot",
        triggerType: "github",
        triggerConfig: {
          events: ["push"],
          branches: ["main"],
        },
        prompt: CODING_TASK_PROMPT,
        agentType: "claude",
        allowPush: true,
        allowPrCreate: true,
      };
    default:
      return null;
  }
}

export async function POST(req: NextRequest) {
  const { session, orgId } = await getSessionWithOrg();
  const body = await req.json();

  const {
    intents,
    repositoryFullName,
    secretId,
  } = body as {
    intents: Intent[];
    repositoryFullName: string;
    secretId: string;
  };

  if (!intents?.length || !repositoryFullName || !secretId) {
    return NextResponse.json(
      { error: "intents, repositoryFullName, and secretId are required" },
      { status: 400 },
    );
  }

  // Find the repository in DB
  const [owner, name] = repositoryFullName.split("/");
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.organizationId, orgId),
        eq(repositories.owner, owner),
        eq(repositories.name, name),
      ),
    )
    .limit(1);

  if (!repo) {
    return NextResponse.json(
      { error: "Repository not found. Try reconnecting GitHub." },
      { status: 404 },
    );
  }

  // Create template automations for each automation-producing intent
  const created: string[] = [];
  for (const intent of intents) {
    const template = getTemplateForIntent(intent);
    if (!template) continue;

    await createAutomation({
      organizationId: orgId,
      createdBy: session.user.id,
      name: template.name,
      mode: template.mode,
      triggerType: template.triggerType,
      triggerConfig: template.triggerConfig,
      prompt: template.prompt,
      agentType: template.agentType,
      repositoryId: repo.id,
      agentSecretId: secretId,
      allowPush: template.allowPush,
      allowPrCreate: template.allowPrCreate,
      prReviewConfig: template.prReviewConfig,
    });
    created.push(template.name);
  }

  // Mark onboarding complete on the org
  const meta = JSON.stringify({
    onboardingCompletedAt: new Date().toISOString(),
    intents,
  });

  await db
    .update(organization)
    .set({ metadata: meta })
    .where(eq(organization.id, orgId));

  return NextResponse.json({
    completed: true,
    automations: created,
  });
}
