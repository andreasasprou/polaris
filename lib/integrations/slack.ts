import crypto from "node:crypto";
import { WebClient } from "@slack/web-api";

export const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export function verifySlackSignature(rawBody: string, headers: Headers) {
  const ts = headers.get("x-slack-request-timestamp");
  const sig = headers.get("x-slack-signature");
  if (!ts || !sig) return false;

  const fiveMinutes = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > fiveMinutes) return false;

  const base = `v0:${ts}:${rawBody}`;
  const digest =
    "v0=" +
    crypto
      .createHmac("sha256", process.env.SLACK_SIGNING_SECRET!)
      .update(base)
      .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));
}

export async function postThreadRoot(params: {
  channelId: string;
  text: string;
}) {
  const res = await slack.chat.postMessage({
    channel: params.channelId,
    text: params.text,
  });

  return { ts: res.ts! };
}

export async function postThreadReply(params: {
  channelId: string;
  threadTs: string;
  text: string;
  blocks?: unknown[];
}) {
  await slack.chat.postMessage({
    channel: params.channelId,
    thread_ts: params.threadTs,
    text: params.text,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocks: params.blocks as any,
  });
}
