import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import {
  getJobForOrg,
  getJobAttempts,
  getJobEvents,
  getJobCallbacks,
} from "@/lib/jobs/actions";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { jobId } = await params;

  const job = await getJobForOrg(jobId, orgId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const [attempts, events, callbacks] = await Promise.all([
    getJobAttempts(jobId),
    getJobEvents(jobId),
    getJobCallbacks(jobId),
  ]);

  return NextResponse.json({ job, attempts, events, callbacks });
}
