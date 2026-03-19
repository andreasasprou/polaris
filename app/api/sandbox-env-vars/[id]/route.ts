import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { deleteEnvVar } from "@/lib/sandbox-env/actions";
import { withEvlog } from "@/lib/evlog";

export const DELETE = withEvlog(async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { orgId } = await getSessionWithOrg();
  const { id } = await params;

  await deleteEnvVar(id, orgId);
  return NextResponse.json({ ok: true });
});
