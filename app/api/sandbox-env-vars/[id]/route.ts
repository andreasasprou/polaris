import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { deleteEnvVar } from "@/lib/sandbox-env/actions";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { id } = await params;

  await deleteEnvVar(id, orgId);
  return NextResponse.json({ ok: true });
}
