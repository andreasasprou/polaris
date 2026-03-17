import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findAutomationById } from "@/lib/automations/queries";
import { updateAutomation, deleteAutomation } from "@/lib/automations/actions";
import { validateAutomationRelationsForOrg } from "@/lib/automations/validation";
import { RequestError } from "@/lib/errors/request-error";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { orgId } = await getSessionWithOrg();

  const { id } = await params;
  const automation = await findAutomationById(id);

  if (!automation || automation.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ automation });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
  const agentSecretId = Object.prototype.hasOwnProperty.call(body, "agentSecretId")
    ? body.agentSecretId ?? null
    : existing.agentSecretId;

  try {
    const validated = await validateAutomationRelationsForOrg({
      organizationId: orgId,
      repositoryId,
      agentSecretId,
    });
    const automation = await updateAutomation(id, {
      ...body,
      repositoryId: validated.repositoryId,
      agentSecretId: validated.agentSecretId,
    });

    return NextResponse.json({ automation });
  } catch (error) {
    if (error instanceof RequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { orgId } = await getSessionWithOrg();

  const { id } = await params;
  const existing = await findAutomationById(id);

  if (!existing || existing.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await deleteAutomation(id);
  return NextResponse.json({ ok: true });
}
