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

  if (
    typeof body.provider !== "string" || !body.provider ||
    typeof body.label !== "string" || !body.label ||
    typeof body.value !== "string" || !body.value.trim()
  ) {
    return NextResponse.json(
      { error: "provider, label, and value are required (strings)" },
      { status: 400 },
    );
  }

  try {
    const secret = await createSecret({
      organizationId: orgId,
      provider: body.provider,
      label: body.label,
      value: body.value,
      createdBy: session.user.id,
    });

    return NextResponse.json({ secret }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    // Validation errors from validateSecretValue are user-facing
    const isValidation = message.includes("must start with") ||
      message.includes("Invalid") || message.includes("missing") ||
      message.includes("Unsupported provider");
    return NextResponse.json(
      { error: isValidation ? message : "Failed to create secret" },
      { status: isValidation ? 400 : 500 },
    );
  }
}
