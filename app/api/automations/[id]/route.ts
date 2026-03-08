import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { findAutomationById } from "@/lib/automations/queries";
import { updateAutomation, deleteAutomation } from "@/lib/automations/actions";

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

  return NextResponse.json({ automation });
}

export async function PUT(
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
  const automation = await updateAutomation(id, body);

  return NextResponse.json({ automation });
}

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
  const existing = await findAutomationById(id);

  if (!existing || existing.organizationId !== session.session.activeOrganizationId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await deleteAutomation(id);
  return NextResponse.json({ ok: true });
}
