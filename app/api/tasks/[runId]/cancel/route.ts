import { NextRequest, NextResponse } from "next/server";
import { runs } from "@trigger.dev/sdk/v3";
import { getSessionWithOrg } from "@/lib/auth/session";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  await getSessionWithOrg();
  const { runId } = await params;
  await runs.cancel(runId);
  return NextResponse.json({ ok: true });
}
