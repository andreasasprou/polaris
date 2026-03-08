import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { findAutomationById } from "@/lib/automations/queries";
import { toggleAutomation } from "@/lib/automations/actions";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.session.activeOrganizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const existing = await findAutomationById(id);

  if (!existing || existing.organizationId !== session.session.activeOrganizationId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const automation = await toggleAutomation(id, !!body.enabled);

  return NextResponse.json({ automation });
}
