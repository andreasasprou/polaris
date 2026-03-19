import { NextResponse } from "next/server";
import { BodyTooLargeError, readRequestBody } from "@/lib/http/request-body";
import { verifyWebhookSignature } from "@/lib/integrations/github";
import { routeGitHubEvent } from "@/lib/routing/trigger-router";
import { withEvlog, useLogger } from "@/lib/evlog";

const MAX_GITHUB_WEBHOOK_BODY_BYTES = 10 * 1024 * 1024;

export const POST = withEvlog(async (req: Request) => {
  const log = useLogger();

  let payload: string;
  try {
    payload = await readRequestBody(req, MAX_GITHUB_WEBHOOK_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    throw error;
  }

  const signature = req.headers.get("x-hub-signature-256");
  const deliveryId = req.headers.get("x-github-delivery");
  const eventType = req.headers.get("x-github-event");

  log.set({ webhook: { eventType, deliveryId } });

  if (!signature || !deliveryId || !eventType) {
    log.set({ webhook: { outcome: "missing_headers" } });
    return NextResponse.json({ error: "Missing headers" }, { status: 400 });
  }

  // Verify webhook signature
  try {
    if (!verifyWebhookSignature(payload, signature)) {
      log.set({ webhook: { outcome: "invalid_signature" } });
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } catch (err) {
    log.error(err instanceof Error ? err : new Error(String(err)));
    return NextResponse.json({ error: "Signature verification failed" }, { status: 500 });
  }

  const body = JSON.parse(payload) as Record<string, unknown>;
  const installationId = (body.installation as { id?: number } | undefined)?.id;
  const action = typeof body.action === "string" ? body.action : undefined;
  const ref = typeof body.ref === "string" ? body.ref : undefined;

  log.set({ webhook: { action, ref, installationId } });

  if (!installationId) {
    log.set({ webhook: { outcome: "no_installation" } });
    return NextResponse.json({ ok: true });
  }

  try {
    const triggered = await routeGitHubEvent({
      installationId,
      deliveryId,
      eventType,
      action,
      ref,
      payload: body,
    });

    log.set({ webhook: { triggered } });
    return NextResponse.json({ ok: true, triggered });
  } catch (err) {
    log.error(err instanceof Error ? err : new Error(String(err)));
    return NextResponse.json({ error: "Internal routing error" }, { status: 500 });
  }
});
