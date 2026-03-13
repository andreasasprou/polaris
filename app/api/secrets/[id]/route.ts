import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findSecretById } from "@/lib/secrets/queries";
import { revokeSecret } from "@/lib/secrets/actions";

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
