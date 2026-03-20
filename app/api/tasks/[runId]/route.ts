import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/tasks/:runId — legacy run status endpoint (deprecated).
 * Use GET /api/jobs/[id] instead.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  return NextResponse.json(
    { error: "This endpoint is deprecated. Use the job-based API." },
    { status: 410 },
  );
}
