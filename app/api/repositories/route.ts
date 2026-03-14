import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findRepositoriesByOrg } from "@/lib/integrations/queries";

export async function GET() {
  const { orgId } = await getSessionWithOrg();
  const repositories = await findRepositoriesByOrg(orgId);
  return NextResponse.json({ repositories });
}
