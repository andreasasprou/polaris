import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { addKeyToPool } from "@/lib/key-pools/actions";
import { RequestError } from "@/lib/errors/request-error";
import { withEvlog } from "@/lib/evlog";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = withEvlog(async (req: Request, ctx: RouteParams) => {
  const { orgId } = await getSessionWithOrg();
  const { id: poolId } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.secretId !== "string" || !body.secretId) {
    return NextResponse.json({ error: "secretId is required" }, { status: 400 });
  }

  try {
    const member = await addKeyToPool({
      poolId,
      secretId: body.secretId,
      organizationId: orgId,
    });

    if (!member) {
      return NextResponse.json({ message: "Key already in pool" });
    }

    return NextResponse.json({ member }, { status: 201 });
  } catch (err) {
    if (err instanceof RequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
