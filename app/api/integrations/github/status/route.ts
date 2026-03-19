import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findGithubInstallationsByOrg } from "@/lib/integrations/queries";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async () => {
  try {
    const { orgId } = await getSessionWithOrg();
    const installations = await findGithubInstallationsByOrg(orgId);
    return NextResponse.json({
      installed: installations.length > 0,
      count: installations.length,
    });
  } catch {
    return NextResponse.json({ installed: false, count: 0 });
  }
});
