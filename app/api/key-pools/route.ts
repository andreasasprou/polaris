import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findKeyPoolsByOrg } from "@/lib/key-pools/queries";
import { createKeyPool } from "@/lib/key-pools/actions";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async () => {
  const { orgId } = await getSessionWithOrg();

  const pools = await findKeyPoolsByOrg(orgId);
  return NextResponse.json({ pools });
});

export const POST = withEvlog(async (req: Request) => {
  const { session, orgId } = await getSessionWithOrg();
  const body = await req.json();

  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!["anthropic", "openai"].includes(body.provider)) {
    return NextResponse.json(
      { error: 'provider must be "anthropic" or "openai"' },
      { status: 400 },
    );
  }

  try {
    const pool = await createKeyPool({
      organizationId: orgId,
      name: body.name,
      provider: body.provider,
      createdBy: session.user.id,
    });
    return NextResponse.json({ pool }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create key pool";
    const isDupe = message.includes("unique") || message.includes("duplicate");
    return NextResponse.json(
      { error: isDupe ? "A pool with that name already exists" : message },
      { status: isDupe ? 409 : 500 },
    );
  }
});
