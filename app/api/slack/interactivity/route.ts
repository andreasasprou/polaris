import { NextRequest, NextResponse } from "next/server";
import { wait } from "@trigger.dev/sdk/v3";
import { verifySlackSignature } from "@/lib/integrations/slack";

export async function POST(req: NextRequest) {
  const raw = await req.text();

  if (!verifySlackSignature(raw, req.headers)) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  const form = new URLSearchParams(raw);
  const payload = JSON.parse(form.get("payload")!);

  if (payload.type !== "block_actions") {
    return NextResponse.json({ ok: true });
  }

  const action = payload.actions?.[0];
  if (!action?.value) {
    return NextResponse.json({ ok: true });
  }

  const parsed = JSON.parse(action.value) as {
    runId: string;
    tokenId: string;
    accept: boolean;
  };

  await wait.completeToken(parsed.tokenId, {
    accept: parsed.accept,
    reason: parsed.accept ? "Approved in Slack." : "Rejected in Slack.",
  });

  return NextResponse.json({
    text: parsed.accept ? "Approved." : "Rejected.",
  });
}
