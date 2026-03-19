import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findAutomationsByOrg } from "@/lib/automations/queries";
import { createAutomation } from "@/lib/automations/actions";
import { validateAutomationRelationsForOrg } from "@/lib/automations/validation";
import { RequestError } from "@/lib/errors/request-error";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async () => {
  const { orgId } = await getSessionWithOrg();

  const automations = await findAutomationsByOrg(orgId);
  return NextResponse.json({ automations });
});

export const POST = withEvlog(async (req: Request) => {
  const { session, orgId } = await getSessionWithOrg();

  const body = await req.json();

  try {
    const { repositoryId, agentSecretId } = await validateAutomationRelationsForOrg({
      organizationId: orgId,
      repositoryId: body.repositoryId ?? null,
      agentSecretId: body.agentSecretId ?? null,
    });

    const automation = await createAutomation({
      organizationId: orgId,
      createdBy: session.user.id,
      name: body.name,
      triggerType: body.triggerType,
      triggerConfig: body.triggerConfig,
      prompt: body.prompt,
      agentType: body.agentType,
      model: body.model,
      agentMode: body.agentMode,
      repositoryId: repositoryId ?? undefined,
      agentSecretId: agentSecretId ?? undefined,
      maxDurationSeconds: body.maxDurationSeconds,
      maxConcurrentRuns: body.maxConcurrentRuns,
      allowPush: body.allowPush,
      allowPrCreate: body.allowPrCreate,
      mode: body.mode,
      modelParams: body.modelParams,
      prReviewConfig: body.prReviewConfig,
    });

    return NextResponse.json({ automation }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
});
