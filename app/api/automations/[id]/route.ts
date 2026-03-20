import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findAutomationById } from "@/lib/automations/queries";
import { updateAutomation, deleteAutomation } from "@/lib/automations/actions";
import { validateAutomationRelationsForOrg } from "@/lib/automations/validation";
import { RequestError } from "@/lib/errors/request-error";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { orgId } = await getSessionWithOrg();

  const { id } = await params;
  const automation = await findAutomationById(id);

  if (!automation || automation.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ automation });
});

export const PUT = withEvlog(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { orgId } = await getSessionWithOrg();

  const { id } = await params;
  const existing = await findAutomationById(id);

  if (!existing || existing.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const repositoryId = Object.prototype.hasOwnProperty.call(body, "repositoryId")
    ? body.repositoryId ?? null
    : existing.repositoryId;

  // Determine agentSecretId / keyPoolId with explicit nulling on switch
  const hasSecretInBody = Object.prototype.hasOwnProperty.call(body, "agentSecretId");
  const hasPoolInBody = Object.prototype.hasOwnProperty.call(body, "keyPoolId");

  // Reject payloads that explicitly set both credential fields
  if (hasSecretInBody && hasPoolInBody && body.agentSecretId && body.keyPoolId) {
    return NextResponse.json(
      { error: "Cannot set both agentSecretId and keyPoolId" },
      { status: 400 },
    );
  }

  // When setting one, null the other to satisfy the CHECK constraint
  let agentSecretId = hasSecretInBody ? (body.agentSecretId || null) : existing.agentSecretId;
  let keyPoolId = hasPoolInBody ? (body.keyPoolId || null) : existing.keyPoolId;

  // Auto-null the other column when switching credential source
  if (hasPoolInBody && keyPoolId) agentSecretId = null;
  else if (hasSecretInBody && agentSecretId) keyPoolId = null;

  try {
    const validated = await validateAutomationRelationsForOrg({
      organizationId: orgId,
      repositoryId,
      agentSecretId,
      keyPoolId,
    });
    const automation = await updateAutomation(id, {
      ...body,
      repositoryId: validated.repositoryId,
      agentSecretId: validated.agentSecretId,
      keyPoolId: validated.keyPoolId,
    });

    return NextResponse.json({ automation });
  } catch (error) {
    if (error instanceof RequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
});

export const DELETE = withEvlog(async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { orgId } = await getSessionWithOrg();

  const { id } = await params;
  const existing = await findAutomationById(id);

  if (!existing || existing.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await deleteAutomation(id);
  return NextResponse.json({ ok: true });
});
