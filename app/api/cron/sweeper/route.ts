import { NextResponse } from "next/server";
import { runSweep } from "@/lib/jobs/sweeper";

// Vercel Cron handler — runs every 2 minutes.
// Configure in vercel.json crons array with path "/api/cron/sweeper".
export async function GET(req: Request) {
  const isDevelopment = process.env.NODE_ENV === "development"
    || process.env.VERCEL_ENV === "development";
  const cronSecret = process.env.CRON_SECRET;
  if (!isDevelopment) {
    if (!cronSecret) {
      return NextResponse.json(
        { ok: false, error: "CRON_SECRET is required outside development" },
        { status: 500 },
      );
    }

    if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
  }

  try {
    const result = await runSweep();
    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error("[cron/sweeper] Sweep failed:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
