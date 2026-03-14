import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/auth-schema";
import { eq } from "drizzle-orm";

export async function GET() {
  try {
    const { orgId } = await getSessionWithOrg();

    const [org] = await db
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);

    if (!org?.metadata) {
      return NextResponse.json({ completed: false });
    }

    const meta = JSON.parse(org.metadata) as Record<string, unknown>;
    return NextResponse.json({
      completed: !!meta.onboardingCompletedAt,
    });
  } catch {
    return NextResponse.json({ completed: false });
  }
}
