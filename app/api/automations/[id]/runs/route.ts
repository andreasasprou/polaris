import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { findAutomationById } from "@/lib/automations/queries";
import { findRunsByAutomation } from "@/lib/automations/queries";

export async function GET(
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
  const automation = await findAutomationById(id);

  if (!automation || automation.organizationId !== session.session.activeOrganizationId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const runs = await findRunsByAutomation(id);
  return NextResponse.json({ runs });
}
