import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/tasks/:runId — legacy Trigger.dev run status endpoint.
 * Replaced by job-based status in v2. Will be removed.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  return NextResponse.json(
    { error: "Trigger.dev run endpoints are deprecated. Use job-based API." },
    { status: 410 },
  );
}
