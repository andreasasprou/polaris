import { task } from "@trigger.dev/sdk/v3";
import { postThreadReply } from "@/lib/integrations/slack";

export const notifySlack = task({
  id: "notify-slack",
  run: async (input: {
    channelId: string;
    threadTs: string;
    text: string;
    blocks?: unknown[];
  }) => {
    await postThreadReply(input);
    return { ok: true };
  },
});
