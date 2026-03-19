import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findEnvVarsByOrg } from "@/lib/sandbox-env/queries";
import { upsertEnvVar } from "@/lib/sandbox-env/actions";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async () => {
  const { orgId } = await getSessionWithOrg();
  const envVars = await findEnvVarsByOrg(orgId);
  return NextResponse.json({ envVars });
});

export const POST = withEvlog(async (req: Request) => {
  const { session, orgId } = await getSessionWithOrg();
  const body = await req.json();

  if (!body.key?.trim() || !body.value) {
    return NextResponse.json(
      { error: "key and value are required" },
      { status: 400 },
    );
  }

  // Validate key format: uppercase letters, digits, underscores
  if (!/^[A-Z][A-Z0-9_]*$/.test(body.key.trim())) {
    return NextResponse.json(
      { error: "Key must be uppercase letters, digits, and underscores (e.g. OPENAI_API_KEY)" },
      { status: 400 },
    );
  }

  const envVar = await upsertEnvVar({
    organizationId: orgId,
    key: body.key.trim(),
    value: body.value,
    createdBy: session.user.id,
  });

  return NextResponse.json({ envVar }, { status: 201 });
});
