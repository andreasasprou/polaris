import { NextRequest, NextResponse } from "next/server";
import { getSessionEvents } from "@/lib/sandbox-agent/queries";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const offset = Number(url.searchParams.get("offset") ?? "0");

  const result = await getSessionEvents(sessionId, { limit, offset });

  return NextResponse.json(result);
}
