import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findSecretsByOrg } from "@/lib/secrets/queries";
import { createSecret } from "@/lib/secrets/actions";

export async function GET() {
  const { orgId } = await getSessionWithOrg();

  const secrets = await findSecretsByOrg(orgId);
  return NextResponse.json({ secrets });
}

export async function POST(req: NextRequest) {
  const { session, orgId } = await getSessionWithOrg();

  const body = await req.json();

  if (!body.provider || !body.label || !body.value) {
    return NextResponse.json(
      { error: "provider, label, and value are required" },
      { status: 400 },
    );
  }

  const secret = await createSecret({
    organizationId: orgId,
    provider: body.provider,
    label: body.label,
    value: body.value,
    createdBy: session.user.id,
  });

  return NextResponse.json({ secret }, { status: 201 });
}
