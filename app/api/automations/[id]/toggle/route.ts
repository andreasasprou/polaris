import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findAutomationById } from "@/lib/automations/queries";
import { toggleAutomation } from "@/lib/automations/actions";

export async function POST(
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
  const automation = await toggleAutomation(id, !!body.enabled);

  return NextResponse.json({ automation });
}
