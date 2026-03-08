import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { findSecretsByOrg } from "@/lib/secrets/queries";
import { createSecret } from "@/lib/secrets/actions";

export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.session.activeOrganizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secrets = await findSecretsByOrg(session.session.activeOrganizationId);
  return NextResponse.json({ secrets });
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.session.activeOrganizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  if (!body.provider || !body.label || !body.value) {
    return NextResponse.json(
      { error: "provider, label, and value are required" },
      { status: 400 },
    );
  }

  const secret = await createSecret({
    organizationId: session.session.activeOrganizationId,
    provider: body.provider,
    label: body.label,
    value: body.value,
    createdBy: session.user.id,
  });

  return NextResponse.json({ secret }, { status: 201 });
}
