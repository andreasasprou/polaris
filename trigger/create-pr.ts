import { task } from "@trigger.dev/sdk/v3";
import { createPullRequest } from "@/lib/integrations/github";

export const createPr = task({
  id: "create-pr",
  run: async (input: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }) => {
    return createPullRequest(input);
  },
});
