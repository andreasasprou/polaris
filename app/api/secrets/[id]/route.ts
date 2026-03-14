import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findSecretById } from "@/lib/secrets/queries";
import { revokeSecret, updateSecret } from "@/lib/secrets/actions";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { id } = await params;

  const body = await req.json();
  if (!body.value) {
    return NextResponse.json(
      { error: "value is required" },
      { status: 400 },
    );
  }

  try {
    const updated = await updateSecret({
      id,
      organizationId: orgId,
      value: body.value,
    });
    return NextResponse.json({ secret: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed";
    const status = message === "Secret not found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { orgId } = await getSessionWithOrg();

  const { id } = await params;
  const secret = await findSecretById(id);

  if (!secret || secret.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await revokeSecret(id);
  return NextResponse.json({ ok: true });
}
