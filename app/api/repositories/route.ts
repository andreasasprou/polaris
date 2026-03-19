import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findRepositoriesByOrg } from "@/lib/integrations/queries";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async () => {
  const { orgId } = await getSessionWithOrg();
  const repositories = await findRepositoriesByOrg(orgId);
  return NextResponse.json({ repositories });
});
