import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/integrations/github";
import { routeGitHubEvent } from "@/lib/routing/trigger-router";

export async function POST(req: NextRequest) {
  const payload = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const deliveryId = req.headers.get("x-github-delivery");
  const eventType = req.headers.get("x-github-event");

  if (!signature || !deliveryId || !eventType) {
    return NextResponse.json({ error: "Missing headers" }, { status: 400 });
  }

  // Verify webhook signature
  try {
    if (!verifyWebhookSignature(payload, signature)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "Signature verification failed" }, { status: 500 });
  }

  const body = JSON.parse(payload) as Record<string, unknown>;
  const installationId = (body.installation as { id?: number } | undefined)?.id;

  if (!installationId) {
    // Some events don't have an installation — ignore them
    return NextResponse.json({ ok: true });
  }

  const action = typeof body.action === "string" ? body.action : undefined;
  const ref = typeof body.ref === "string" ? body.ref : undefined;

  const triggered = await routeGitHubEvent({
    installationId,
    deliveryId,
    eventType,
    action,
    ref,
    payload: body,
  });

  return NextResponse.json({ ok: true, triggered });
}
