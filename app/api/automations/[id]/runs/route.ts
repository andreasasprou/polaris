import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findAutomationById, findRunsByAutomation } from "@/lib/automations/queries";

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

  const runs = await findRunsByAutomation(id);
  return NextResponse.json({ runs });
}
