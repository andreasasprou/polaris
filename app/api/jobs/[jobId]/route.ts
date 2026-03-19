import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import {
  getJobForOrg,
  getJobAttempts,
  getJobEvents,
  getJobCallbacks,
} from "@/lib/jobs/actions";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async (
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) => {
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
});
