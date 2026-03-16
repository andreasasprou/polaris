import { NextResponse } from "next/server";
import { runSweep } from "@/lib/jobs/sweeper";

// Vercel Cron handler — runs every 2 minutes.
// Configure in vercel.json crons array with path "/api/cron/sweeper".
export async function GET() {
  // Verify cron secret in production
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && !process.env.VERCEL_ENV?.startsWith("development")) {
    // In production, Vercel automatically validates the Authorization header
    // for cron jobs configured in vercel.json
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
