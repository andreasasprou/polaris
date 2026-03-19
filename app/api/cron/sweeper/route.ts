import { NextResponse } from "next/server";
import { runSweep } from "@/lib/orchestration/sweeper";
import { withEvlog, useLogger } from "@/lib/evlog";

// Vercel Cron handler — runs every 2 minutes.
// Configure in vercel.json crons array with path "/api/cron/sweeper".
export const GET = withEvlog(async (req: Request) => {
  const log = useLogger();

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
    log.set({ sweep: result });
    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    log.error(error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
});
