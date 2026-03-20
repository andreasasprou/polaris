import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { removeKeyFromPool, togglePoolMember } from "@/lib/key-pools/actions";
import { RequestError } from "@/lib/errors/request-error";
import { withEvlog } from "@/lib/evlog";

type RouteParams = { params: Promise<{ id: string; secretId: string }> };

export const DELETE = withEvlog(async (_req: Request, ctx: RouteParams) => {
  const { orgId } = await getSessionWithOrg();
  const { id: poolId, secretId } = await ctx.params;

  try {
    await removeKeyFromPool({ poolId, secretId, organizationId: orgId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});

export const PATCH = withEvlog(async (req: Request, ctx: RouteParams) => {
  const { orgId } = await getSessionWithOrg();
  const { id: poolId, secretId } = await ctx.params;
  const body = await req.json();

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled (boolean) is required" }, { status: 400 });
  }

  try {
    const member = await togglePoolMember({
      poolId,
      secretId,
      organizationId: orgId,
      enabled: body.enabled,
    });
    return NextResponse.json({ member });
  } catch (err) {
    if (err instanceof RequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
