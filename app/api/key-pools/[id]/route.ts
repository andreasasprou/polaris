import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findKeyPoolByIdAndOrg, findKeyPoolMembers } from "@/lib/key-pools/queries";
import { updateKeyPool, deleteKeyPool } from "@/lib/key-pools/actions";
import { RequestError } from "@/lib/errors/request-error";
import { withEvlog } from "@/lib/evlog";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = withEvlog(async (_req: Request, ctx: RouteParams) => {
  const { orgId } = await getSessionWithOrg();
  const { id } = await ctx.params;

  const pool = await findKeyPoolByIdAndOrg(id, orgId);
  if (!pool) {
    return NextResponse.json({ error: "Key pool not found" }, { status: 404 });
  }

  const members = await findKeyPoolMembers(id);
  return NextResponse.json({ pool, members });
});

export const PUT = withEvlog(async (req: Request, ctx: RouteParams) => {
  const { orgId } = await getSessionWithOrg();
  const { id } = await ctx.params;
  const body = await req.json();

  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    const pool = await updateKeyPool({ id, organizationId: orgId, name: body.name });
    return NextResponse.json({ pool });
  } catch (err) {
    if (err instanceof RequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});

export const DELETE = withEvlog(async (_req: Request, ctx: RouteParams) => {
  const { orgId } = await getSessionWithOrg();
  const { id } = await ctx.params;

  try {
    await deleteKeyPool(id, orgId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
