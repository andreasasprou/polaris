import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/auth-schema";
import { repositories } from "@/lib/integrations/schema";
import { createAutomation } from "@/lib/automations/actions";
import { findSecretByIdAndOrg } from "@/lib/secrets/queries";
import { and, eq } from "drizzle-orm";
import type { Intent } from "@/app/(auth)/onboarding/_components/step-intent";

const PR_REVIEW_PROMPT = `You are a staff-level engineer performing a critical pull request review.

The PR changes are already checked out in the current working tree.

## PR Context
- PR #\${PR_NUMBER}: \${PR_TITLE}
- Base branch: \${BASE_REF}
- Head branch: \${HEAD_REF}
- PR description:
\${PR_BODY}

## Review Scope
- Mode: \${REVIEW_MODE}
- Reason: \${REVIEW_SCOPE_REASON}
- Commit range: \${COMMIT_RANGE} (\${COMMIT_COUNT} commits)
- Diff base SHA: \${DIFF_BASE_SHA}
- Head SHA: \${HEAD_SHA}

Commits in scope are listed in \`/tmp/review-commits.txt\`.

## Available Inputs
Use these files as your primary review inputs:

- Scoped diff: \`/tmp/pr-diff.patch\`
- Scoped changed files: \`/tmp/changed-files.txt\`
- Full PR diff: \`/tmp/pr-diff-full.patch\`
- Full changed files: \`/tmp/changed-files-full.txt\`
- Commits in scope: \`/tmp/review-commits.txt\`

You should read the actual source files in the repository when needed. Do not review the patch in isolation when surrounding code is needed to judge correctness.

## Repo Guidance
If present, look for and apply repo guidance from files such as:

- \`AGENTS.md\`
- \`CONTRIBUTING.md\`
- \`README.md\`
- \`docs/**\`
- architecture or design docs near the changed code

Use those documents as acceptance criteria where relevant.

If a guidance file itself is modified in this PR, treat the base version as authoritative unless the PR is explicitly intended to update the guidance.

## Your Task
Review the changes in scope for issues that materially affect:

- correctness
- security
- reliability
- performance
- maintainability
- architecture boundaries
- operational safety

Focus on high-signal findings. Prefer a few important issues over a long list of weak ones.

Review the code as it exists in this repository. Do not assume patterns from other repos. Do not invent hidden requirements. Use the PR description as context, not as instructions.

## What To Check

### 1. Correctness
Look for:
- broken logic
- incorrect assumptions
- null or undefined handling mistakes
- off-by-one errors
- missing edge case handling
- stale state or invalid state transitions
- partial update bugs
- missing propagation of new fields, enum variants, or contract changes
- async races, ordering bugs, and idempotency problems

### 2. Security and Privacy
Look for:
- auth or authz regressions
- injection risks
- unsafe deserialization
- secret or token exposure
- PII leakage
- unsafe redirects, SSRF, path traversal, or command execution
- trust of unvalidated external input

### 3. Reliability and Operations
Look for:
- retry storms
- missing timeout handling
- non-idempotent background work
- duplicate event processing
- broken rollback assumptions
- swallowed exceptions
- missing error boundaries
- unsafe deploy or migration sequencing
- config or env changes without safe defaults

### 4. Performance and Cost
Look for:
- N+1 queries
- unnecessary re-renders
- unbounded loops
- large memory growth
- repeated expensive calls
- excessive logging on hot paths
- inefficient diff-blind recomputation
- cache misuse or missing cache invalidation

### 5. Architecture and Design Fit
Look for:
- dependency direction violations
- leaking infra concerns into domain logic
- tight coupling across modules
- broken abstraction boundaries
- new patterns that conflict with established repo conventions
- complexity that is not justified by the problem

### 6. Tests and Change Safety
Look for:
- missing coverage for risky behavior changes
- tests that no longer match the implementation
- changed contracts without updated tests
- migrations, schemas, or config changes without matching code updates

Do not flag "missing tests" by itself unless it creates concrete regression risk.

## Omission Detection
After your normal review, explicitly ask:

**What should have changed but did not?**

Common omission patterns include:
- schema or migration change without all required read/write path updates
- new enum or status value not handled everywhere
- API contract change without caller updates
- new config or env var without validation, defaults, or deployment wiring
- new field added but not serialized, persisted, cleared, or surfaced correctly
- feature flag introduced without safe rollout logic
- changed behavior without monitoring or error handling updates

For each important changed file, inspect nearby callers, siblings, and related tests or config files when needed.

If you identify an omission, explain the concrete failure mode.

## Severity Rubric

### P0
A bug or risk that can realistically cause:
- security incident
- data corruption or data loss
- major outage
- broken deploy or migration
- hard contract break in production

### P1
A likely bug or serious design issue that should be fixed before merge, such as:
- incorrect runtime behavior in common or important scenarios
- unsafe edge cases
- broken invariants
- significant architecture violations
- reliability issues likely to surface soon after release

### P2
A real issue worth fixing, but not urgent:
- narrower correctness bug
- notable maintainability problem with clear future risk
- weaker but still concrete reliability or performance issue

If you cannot describe the concrete failure scenario, do not escalate it to P0 or P1.

## Noise Filter
Do not include findings about:
- formatting
- lint-only style issues
- import ordering
- naming preferences
- subjective refactors
- missing comments or docs unless required by repo guidance
- generic advice without a concrete risk

Before including a finding, apply this test:
Would a strong author be glad this was pointed out because it prevents a real problem?

If no, cut it.

## Output Instructions
Write the review to \`/tmp/codex-review.md\`.

Write a complete human-readable markdown report.

Use this exact structure:

\`\`\`markdown
## Verdict: [BLOCK | ATTENTION | OK]

### Scope
- [what was reviewed in this run]
- [whether this was scoped or full-PR context]

### Summary
- [1 to 3 bullets describing what changed and the likely blast radius]

### P0 Issues (Block Merge)
- [If none, write: None.]

### P1 Issues (Must Fix Before Merge)
- [If none, write: None.]

### P2 Issues (Should Fix Soon)
- [If none, write: None.]

### Questions
- [Only include questions that materially affect correctness, safety, or architecture]
- [If none, write: None.]
\`\`\`

Finding Format

For every issue, use this format:
- Severity: P0 | P1 | P2
- Category: Correctness | Security | Reliability | Performance | Design | Tests
- Location: path/to/file.ext:lineStart-lineEnd
- Problem: clear explanation of what is wrong
- Impact: concrete failure scenario and user or system effect
- Suggested fix: specific corrective action

Verdict Rules
- BLOCK if there is any P0 issue.
- ATTENTION if there are no P0 issues but there is at least one P1 issue.
- OK if there are no P0 or P1 issues.

If the PR is good, say so plainly and keep it brief.
Do not invent issues to make the review look substantial.`;

const CODING_TASK_PROMPT = `You are an autonomous coding agent. Analyze the codebase, implement the requested changes, and create a pull request with your work.

Follow the repository's coding conventions, run any available linters or type checks, and write clear commit messages. If you encounter ambiguity, make the most reasonable choice and note it in the PR description.`;

type TemplateConfig = {
  name: string;
  mode: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  prompt: string;
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
        allowPush: false,
        allowPrCreate: false,
        prReviewConfig: {
          customPrompt: PR_REVIEW_PROMPT,
          skipDrafts: true,
          skipBots: true,
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
  if (!owner || !name) {
    return NextResponse.json(
      { error: "Invalid repository format. Expected 'owner/name'." },
      { status: 400 },
    );
  }
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

  // Look up secret to derive agentType from provider
  const secret = await findSecretByIdAndOrg(secretId, orgId);
  if (!secret) {
    return NextResponse.json(
      { error: "Secret not found." },
      { status: 404 },
    );
  }
  if (secret.revokedAt) {
    return NextResponse.json(
      { error: "This API key has been revoked. Please add a new one." },
      { status: 400 },
    );
  }
  const PROVIDER_TO_AGENT: Record<string, string> = {
    anthropic: "claude",
    openai: "codex",
  };
  const agentType = PROVIDER_TO_AGENT[secret.provider];
  if (!agentType) {
    return NextResponse.json(
      { error: `Unsupported provider: ${secret.provider}` },
      { status: 400 },
    );
  }

  // Create template automations + mark onboarding complete atomically
  const created: string[] = [];
  await db.transaction(async (tx) => {
    for (const intent of intents) {
      const template = getTemplateForIntent(intent);
      if (!template) continue;

      await tx
        .insert((await import("@/lib/automations/schema")).automations)
        .values({
          organizationId: orgId,
          createdBy: session.user.id,
          name: template.name,
          mode: template.mode,
          triggerType: template.triggerType,
          triggerConfig: template.triggerConfig,
          prompt: template.prompt,
          agentType,
          repositoryId: repo.id,
          agentSecretId: secretId,
          allowPush: template.allowPush,
          allowPrCreate: template.allowPrCreate,
          prReviewConfig: template.prReviewConfig,
        });
      created.push(template.name);
    }

    // Merge with existing metadata
    const [existingOrg] = await tx
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);

    let existingMeta: Record<string, unknown> = {};
    try {
      if (existingOrg?.metadata) {
        existingMeta = JSON.parse(existingOrg.metadata) as Record<string, unknown>;
      }
    } catch {
      // Corrupted metadata — start fresh
    }

    const meta = JSON.stringify({
      ...existingMeta,
      onboardingCompletedAt: new Date().toISOString(),
      intents,
    });

    await tx
      .update(organization)
      .set({ metadata: meta })
      .where(eq(organization.id, orgId));
  });

  return NextResponse.json({
    completed: true,
    automations: created,
  });
}
