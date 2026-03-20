import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/tasks/:runId/cancel — legacy run cancel endpoint (deprecated).
 * Use DELETE /api/interactive-sessions/[id] instead.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  return NextResponse.json(
    { error: "This endpoint is deprecated. Use the job-based API." },
    { status: 410 },
  );
}
