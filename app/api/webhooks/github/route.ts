import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/integrations/github";
import { routeGitHubEvent } from "@/lib/routing/trigger-router";

export async function POST(req: NextRequest) {
  const payload = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const deliveryId = req.headers.get("x-github-delivery");
  const eventType = req.headers.get("x-github-event");

  console.log(`[webhook] Received ${eventType}${deliveryId ? ` (${deliveryId})` : ""}`);

  if (!signature || !deliveryId || !eventType) {
    console.log("[webhook] Missing required headers, rejecting");
    return NextResponse.json({ error: "Missing headers" }, { status: 400 });
  }

  // Verify webhook signature
  try {
    if (!verifyWebhookSignature(payload, signature)) {
      console.log("[webhook] Invalid signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } catch (err) {
    console.error("[webhook] Signature verification error:", err);
    return NextResponse.json({ error: "Signature verification failed" }, { status: 500 });
  }

  const body = JSON.parse(payload) as Record<string, unknown>;
  const installationId = (body.installation as { id?: number } | undefined)?.id;
  const action = typeof body.action === "string" ? body.action : undefined;
  const ref = typeof body.ref === "string" ? body.ref : undefined;

  console.log("[webhook] Parsed:", {
    eventType,
    action,
    ref,
    installationId,
    deliveryId,
  });

  if (!installationId) {
    console.log("[webhook] No installation ID, skipping");
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

    console.log(`[webhook] Routed: ${triggered} automation(s) triggered`);
    return NextResponse.json({ ok: true, triggered });
  } catch (err) {
    console.error("[webhook] Routing error:", err);
    return NextResponse.json({ error: "Internal routing error" }, { status: 500 });
  }
}
