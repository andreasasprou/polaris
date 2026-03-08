import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { findAutomationsByOrg } from "@/lib/automations/queries";
import { createAutomation } from "@/lib/automations/actions";

export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.session.activeOrganizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const automations = await findAutomationsByOrg(session.session.activeOrganizationId);
  return NextResponse.json({ automations });
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.session.activeOrganizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  const automation = await createAutomation({
    organizationId: session.session.activeOrganizationId,
    createdBy: session.user.id,
    name: body.name,
    triggerType: body.triggerType,
    triggerConfig: body.triggerConfig,
    prompt: body.prompt,
    agentType: body.agentType,
    model: body.model,
    repositoryId: body.repositoryId,
    agentSecretId: body.agentSecretId,
    maxDurationSeconds: body.maxDurationSeconds,
    maxConcurrentRuns: body.maxConcurrentRuns,
    allowPush: body.allowPush,
    allowPrCreate: body.allowPrCreate,
  });

  return NextResponse.json({ automation }, { status: 201 });
}
