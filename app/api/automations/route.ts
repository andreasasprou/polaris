import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findAutomationsByOrg } from "@/lib/automations/queries";
import { createAutomation } from "@/lib/automations/actions";

export async function GET() {
  const { orgId } = await getSessionWithOrg();

  const automations = await findAutomationsByOrg(orgId);
  return NextResponse.json({ automations });
}

export async function POST(req: NextRequest) {
  const { session, orgId } = await getSessionWithOrg();

  const body = await req.json();

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
    repositoryId: body.repositoryId,
    agentSecretId: body.agentSecretId,
    maxDurationSeconds: body.maxDurationSeconds,
    maxConcurrentRuns: body.maxConcurrentRuns,
    allowPush: body.allowPush,
    allowPrCreate: body.allowPrCreate,
    mode: body.mode,
    modelParams: body.modelParams,
    prReviewConfig: body.prReviewConfig,
  });

  return NextResponse.json({ automation }, { status: 201 });
}
