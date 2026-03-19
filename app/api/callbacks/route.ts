import { NextResponse } from "next/server";
import { BodyTooLargeError, readRequestBody } from "@/lib/http/request-body";
import { verifyCallback } from "@/lib/jobs/callback-auth";
import { ingestCallback } from "@/lib/jobs/callbacks";
import { getJob } from "@/lib/jobs/actions";
import type { CallbackType } from "@/lib/jobs/status";
import { withEvlog, useLogger } from "@/lib/evlog";

const MAX_CALLBACK_BODY_BYTES = 1024 * 1024;

/**
 * POST /api/callbacks
 *
 * Receives HMAC-signed callbacks from the sandbox REST proxy.
 * Verifies the signature, then ingests the callback into the job state machine.
 */
export const POST = withEvlog(async (req: Request) => {
  const log = useLogger();
  log.set({ callback: { sourceIp: req.headers.get("x-forwarded-for") ?? "unknown" } });

  let body: {
    jobId: string;
    attemptId: string;
    epoch: number;
    callbackId: string;
    callbackType: CallbackType;
    payload: Record<string, unknown>;
  };
  let rawBody: string;

  try {
    rawBody = await readRequestBody(req, MAX_CALLBACK_BODY_BYTES);
    body = JSON.parse(rawBody) as typeof body;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.jobId || !body.attemptId || !body.callbackId || !body.callbackType) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 },
    );
  }

  log.set({ callback: { jobId: body.jobId, attemptId: body.attemptId, callbackType: body.callbackType } });

  // Look up job to get HMAC key
  const job = await getJob(body.jobId);
  if (!job) {
    return NextResponse.json({ error: "Unknown job" }, { status: 404 });
  }

  // Verify HMAC signature
  const signature = req.headers.get("X-Callback-Signature");
  if (!signature || !job.hmacKey) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const isValid = verifyCallback(
    body as unknown as Record<string, unknown>,
    signature,
    job.hmacKey,
  );
  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Ingest the callback
  try {
    const result = await ingestCallback({
      jobId: body.jobId,
      attemptId: body.attemptId,
      epoch: body.epoch,
      callbackId: body.callbackId,
      callbackType: body.callbackType,
      payload: body.payload ?? {},
    });

    if (result.accepted) {
      log.set({ callback: { accepted: true } });
      return NextResponse.json({ ok: true });
    }

    // Duplicate or stale — return 409 so proxy marks as delivered (no retry)
    log.set({ callback: { accepted: false, reason: result.reason } });
    return NextResponse.json(
      { ok: false, reason: result.reason },
      { status: 409 },
    );
  } catch (error) {
    log.error(error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
});
