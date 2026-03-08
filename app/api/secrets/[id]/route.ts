import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { findSecretById } from "@/lib/secrets/queries";
import { revokeSecret } from "@/lib/secrets/actions";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.session.activeOrganizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const secret = await findSecretById(id);

  if (!secret || secret.organizationId !== session.session.activeOrganizationId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await revokeSecret(id);
  return NextResponse.json({ ok: true });
}
