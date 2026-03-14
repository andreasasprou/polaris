import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import {
  buildSnapshot,
  buildAllSnapshots,
} from "@/lib/sandbox/snapshots/actions";
import type { AgentType } from "@/lib/sandbox-agent/types";

/** Build a snapshot for a single agent type (on-demand). */
export const buildSnapshotTask = task({
  id: "build-snapshot",
  maxDuration: 600, // 10 min

  run: async (payload: { agentType: AgentType }) => {
    const snapshotId = await buildSnapshot(payload.agentType);
    logger.info("Snapshot built", {
      snapshotId,
      agentType: payload.agentType,
    });
    return { snapshotId };
  },
});

/** Weekly refresh — rebuild snapshots for all agent types. */
export const refreshSnapshots = schedules.task({
  id: "refresh-snapshots",
  cron: "0 3 * * 0", // Sunday 3am UTC

  run: async () => {
    logger.info("Building snapshots for all agent types");
    const results = await buildAllSnapshots();
    logger.info("All snapshots rebuilt", { results });
    return results;
  },
});
