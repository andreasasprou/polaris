import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/tasks/:runId/cancel — legacy Trigger.dev run cancel endpoint.
 * Replaced by job-based stop in v2. Will be removed.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  return NextResponse.json(
    { error: "Trigger.dev run endpoints are deprecated. Use job-based API." },
    { status: 410 },
  );
}
