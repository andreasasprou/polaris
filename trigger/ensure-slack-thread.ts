import { task } from "@trigger.dev/sdk/v3";
import { postThreadRoot } from "@/lib/integrations/slack";

export const ensureSlackThread = task({
  id: "ensure-slack-thread",
  run: async (input: {
    channelId: string;
    existingThreadTs?: string;
    title: string;
    repo: string;
  }) => {
    if (input.existingThreadTs) {
      return { threadTs: input.existingThreadTs };
    }

    const root = await postThreadRoot({
      channelId: input.channelId,
      text: `Started agent task: ${input.title}\nRepo: ${input.repo}`,
    });

    return { threadTs: root.ts };
  },
});
